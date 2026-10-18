package bridge

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Corrupt or unreadable persisted state must never be reinterpreted as an
// unknown new conversation. That path may otherwise start a second native
// Claude session against a history whose original checkpoint is still owned.
func TestInteractiveInvalidCheckpointStoreFailsBeforeNewNativeRun(t *testing.T) {
	for _, tc := range []struct {
		name, file string
	}{
		{"invalid JSON", `{"version":`},
		{"incompatible version", `{"version":999,"sessions":{}}`},
		{"missing session map", `{"version":1}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("XDG_CONFIG_HOME", t.TempDir())
			path := interactiveSessionStatePath()
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(tc.file), 0o600); err != nil {
				t.Fatal(err)
			}
			b := newSubscriptionBridge()
			defer bridges.Delete(b)
			rt := &runtimeTUI{bridge: b}
			body := []byte(`{"model":"claude-opus-5-5","messages":[{"role":"user","content":"continue old task"}]}`)
			started := 0
			start := func(context.Context, *Request) (*subscriptionRun, <-chan Event, error) {
				started++
				return nil, nil, errors.New("would start a new native session")
			}
			w := httptest.NewRecorder()
			code, _ := rt.serveMessagesInner(w, httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(string(body))),
				protoAnthropic, "Claude Code", "claude-opus-5-5", "owner", "persisted-conversation", body, &Usage{}, start)
			if code != http.StatusConflict || started != 0 {
				t.Fatalf("invalid checkpoint started=%d code=%d; must fail before native run", started, code)
			}
		})
	}
}

func TestInteractiveCheckpointStoreIntegrityAcceptsValidAndAbsentButRejectsSymlink(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	b := newSubscriptionBridge()
	defer bridges.Delete(b)
	if err := b.verifyInteractiveSessionStore(); err != nil {
		t.Fatalf("fresh account with no checkpoint store refused: %v", err)
	}
	entry := interactiveSessionEntry{SessionID: "native", ConvKey: "known-history-hash", ContextKey: "known-context-hash"}
	if err := b.saveInteractiveSession("owner", "outer", entry); err != nil {
		t.Fatal(err)
	}
	if err := b.verifyInteractiveSessionStore(); err != nil {
		t.Fatalf("valid atomic checkpoint store refused: %v", err)
	}
	path := interactiveSessionStatePath()
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := b.verifyInteractiveSessionStore(); err == nil {
		t.Fatal("public checkpoint store silently accepted")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(t.TempDir(), "other-state")
	if err := os.WriteFile(other, []byte(`{"version":1,"sessions":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, path); err != nil {
		t.Fatal(err)
	}
	if err := b.verifyInteractiveSessionStore(); err == nil {
		t.Fatal("symlink to a foreign checkpoint store accepted")
	}
}
