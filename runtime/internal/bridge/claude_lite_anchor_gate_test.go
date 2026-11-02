//go:build darwin || linux

package bridge

// Regression for the lite path's cold-start restore. The request is the
// truth on the lite path: a Messages-API client sends its whole conversation
// every time. A reply anchor still matches after the client rewrites history
// before that reply, but the saved native transcript retains the old prefix.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func anchorGateOpinions() []Message {
	return []Message{
		{Role: "user", Parts: []Part{{Kind: Text, Text: "Review this plan"}}},
		{Role: "user", Parts: []Part{{Kind: Text, Text: "OPINION-OLD-77: use plan A"}}},
		{Role: "assistant", Parts: []Part{{Kind: Text, Text: "Answer: I reviewed it and accept A"}}},
	}
}

func anchorGateSave(t *testing.T, b *subscriptionBridge, session string) {
	t.Helper()
	base := anchorGateOpinions()
	baseReq := &Request{Model: "claude-opus-5-5", Messages: base}
	keys := conversationKeys(scOwner, base)
	proj := filepath.Join(os.Getenv("CLAUDE_CONFIG_DIR"), "projects", "anchor")
	if err := os.MkdirAll(proj, 0o700); err != nil {
		t.Fatal(err)
	}
	old := `{"type":"user","message":{"role":"user","content":"OPINION-OLD-77: use plan A"}}
{"type":"assistant","message":{"role":"assistant","content":"Answer: I reviewed it and accept A"}}
`
	if err := os.WriteFile(filepath.Join(proj, session+".jsonl"), []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := b.saveInteractiveSession(scOwner, scOuter, interactiveSessionEntry{
		SessionID: session, Model: "claude-opus-5-5", ThreadKey: firstWords(baseReq),
		ConvKey: keys[len(keys)-1], ReplyKey: assistantReplyKey(base[2]),
		ContextKey: turnKey(scOwner, baseReq, nil),
	}); err != nil {
		t.Fatal(err)
	}
}

func TestLiteAnchorOnlyRestoreRebuildsFromTheRequest(t *testing.T) {
	_, runs := scWrapper(t)
	rt, b := scRuntime(t)
	anchorGateSave(t, b, "inner-saved")
	code, out := scServe(t, rt, scOuter, `{"model":"claude-opus-5-5","max_tokens":64,"messages":[
		{"role":"user","content":"Review this plan"},
		{"role":"user","content":"OPINION-NEW-88: use plan B instead"},
		{"role":"assistant","content":"Answer: I reviewed it and accept A"},
		{"role":"user","content":"Evaluate it again"}]}`)
	if code != 200 || !strings.Contains(out, "SC_ANSWER") {
		t.Fatalf("anchor-only continuation failed: %d %s", code, out)
	}
	run := onlyRun(t, runs())
	if run["resume"] == "" || run["resume"] == "inner-saved" {
		t.Fatalf("the saved native session was resumed although only the reply anchor matched: %v", run)
	}
	seed := run["seed.jsonl"]
	if strings.Contains(seed, "OPINION-OLD-77") {
		t.Fatalf("the deleted old opinion reached the native history: %s", seed)
	}
	if n := strings.Count(seed, "OPINION-NEW-88"); n != 1 {
		t.Fatalf("the new opinion must reach the native history exactly once, got %d: %s", n, seed)
	}
	for _, want := range []string{"Review this plan", "Answer: I reviewed it and accept A"} {
		if !strings.Contains(seed, want) {
			t.Fatalf("rebuilt history lacks %q: %s", want, seed)
		}
	}
	if !strings.Contains(seed, "cache_control") {
		t.Fatalf("the rebuilt transcript lost its rebuild cache mark: %s", seed)
	}
	if !strings.Contains(run["stdin"], "Evaluate it again") || strings.Contains(run["stdin"], "OPINION-OLD-77") {
		t.Fatalf("the rebuilt turn was not just the new message: %q", run["stdin"])
	}
	saved, ok, err := b.loadInteractiveSession(scOwner, scOuter)
	if err != nil || !ok || saved.Dirty || saved.SessionID != run["resume"] {
		t.Fatalf("the rebuilt session did not become the clean checkpoint: %+v ok=%t err=%v", saved, ok, err)
	}
}
