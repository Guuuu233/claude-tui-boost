package bridge

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A stateless run parked on a call whose result comes in a request it does
// not continue (the client moved what it had sent it, as a trailing advisory
// that is replaced each turn) is stopped at once: the session rebuilt for the
// request answers that result, and the parked process is not held for
// interactiveParkLongest beside it.
func TestLiteStatelessRebuildLetsGoTheRunItSupersedes(t *testing.T) {
	resetRebuildMarks(t)
	dir := olDir(t)
	olWrapper(t, dir, "sc-park-bridge", olParkScript())
	rt, b := scRuntime(t)
	t.Setenv("DAV1878_PARK_RELEASE", filepath.Join(dir, "never"))
	first := `{"model":"claude-opus-5-5","max_tokens":64,"tools":[{"name":"write_file","input_schema":{"type":"object"}}],"messages":[
		{"role":"user","content":"把结果写进 notes.txt\n\n[Mixture of Agents reference context]\nAdvice A"}]}`
	if code, out := scServe(t, rt, "", first); code != 200 || !strings.Contains(out, `"type":"tool_use"`) {
		t.Fatalf("first stateless turn did not park: %d %s", code, out)
	}
	var parked *subscriptionRun
	b.mu.Lock()
	for _, r := range b.runs {
		parked = r
	}
	b.mu.Unlock()
	if parked == nil {
		t.Fatal("no parked run")
	}
	// The MCP helper registers the live call, as Claude Code's would.
	go func() {
		w := httptest.NewRecorder()
		mr := httptest.NewRequest("POST", "/_magpie/claude-mcp/"+parked.token,
			strings.NewReader(`{"tool_call_id":"call_1","name":"write_file","arguments":{"path":"a"}}`))
		mr = mr.WithContext(context.WithValue(mr.Context(), mcpTokenKey{}, parked.token))
		b.mcpCall(w, mr)
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		b.mu.Lock()
		waiting := b.calls["call_1"] == parked
		b.mu.Unlock()
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the MCP callback never registered")
		}
		time.Sleep(5 * time.Millisecond)
	}
	_, runs := scWrapper(t)
	code, out := scServe(t, rt, "", `{"model":"claude-opus-5-5","max_tokens":64,"tools":[{"name":"write_file","input_schema":{"type":"object"}}],"messages":[
		{"role":"user","content":"把结果写进 notes.txt"},
		{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"write_file","input":{"path":"a"}}]},
		{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"written ok"},{"type":"text","text":"[Mixture of Agents reference context]\nAdvice B"}]}]}`)
	if code != 200 || !strings.Contains(out, "SC_ANSWER") {
		t.Fatalf("the rewritten continuation was not rebuilt: %d %s", code, out)
	}
	seed := onlyRun(t, runs())["seed.jsonl"]
	if strings.Contains(seed, "Advice A") || !strings.Contains(seed, "written ok") || strings.Count(seed, `"cache_control"`) != 1 {
		t.Fatalf("rebuilt seed: %s", seed)
	}
	olWaitReaped(t, parked)
	parked.mu.Lock()
	closed := parked.closed
	parked.mu.Unlock()
	if !closed {
		t.Fatal("the superseded parked run was left holding its process")
	}
}

// A run that is still answering is never stopped for a rebuilt request.
func TestLetGoSupersededLeavesAnAnsweringRunAlone(t *testing.T) {
	b := newSubscriptionBridge()
	defer bridges.Delete(b)
	r := &subscriptionRun{bridge: b, interactive: true}
	b.letGoSuperseded(r) // neither parked nor done: nothing to stop
	r.mu.Lock()
	closed := r.closed
	r.mu.Unlock()
	if closed {
		t.Fatal("an answering run was stopped")
	}
}
