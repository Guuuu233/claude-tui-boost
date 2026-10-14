package bridge

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInteractiveSessionStateWritten(t *testing.T) {
	tmp := t.TempDir()
	Init(&Config{StateDir: tmp, Models: map[string]string{"m": "m"}})
	b := newSubscriptionBridge()
	e := interactiveSessionEntry{SessionID: "s1", ConvKey: "k", ContextKey: "c", ThreadKey: "t", Model: "m"}
	b.saveInteractiveSession("owner", "outer", e)
	p := filepath.Join(tmp, "claude-interactive-sessions.json")
	b2, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(b2) == 0 {
		t.Fatal("empty state file")
	}
	t.Log(string(b2))
}
