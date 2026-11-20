package bridge

// DAV-1888 regression tests for the terminal-cleanup window mis-409.
//
// The Linux DAV-1887 e2e proved a real regression: a canonical PTY run
// whose complete reply was delivered and whose clean checkpoint was saved
// still owns liveOuter until its child is reaped — the wrapper's tmux
// EXIT_HOLD_MS (~2s) teardown window. A normal next-turn request that
// arrives inside that window was refused errInteractiveOuterLive as if a
// second PTY were still running. These tests pin the fixed semantics:
//
//   - a proven terminal-delivered run (complete non-tool reply delivered,
//     clean canonical checkpoint saved, no read-only tool signal) lets the
//     next canonical request wait, outside the lock, for the owner to be
//     reaped and removed, then start normally;
//   - a still-executing, parked, failed, read-only-signaled, cancelled or
//     unknown-state live run keeps refusing a second canonical PTY;
//   - waiting never overlaps the old and new child, never forces an early
//     liveOuter release, and fails closed on timeout/context cancel.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// tcWrapper installs a fake claude-bridge whose behaviour is selected per
// launch from the MAGPIE_TC_SCRIPT env var, so each HTTP request can pick
// its own script.
func tcWrapper(t *testing.T, dir string) {
	t.Helper()
	p := filepath.Join(dir, "tc-bridge")
	script := "#!/bin/sh\nexec /bin/sh \"$MAGPIE_TC_SCRIPT\"\n"
	if err := os.WriteFile(p, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv(interactiveBridgeEnv, p)
}

func tcScript(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	return p
}

// tcAnswerScript emits one complete assistant text row and a terminal
// result, then waits for GATEFILE (or times out) before exiting —
// modelling the wrapper's tmux EXIT_HOLD teardown.
func tcAnswerScript() string {
	return "#!/bin/sh\n" +
		"cat >/dev/null\n" +
		"printf '%s\\n' '{\"type\":\"assistant\",\"uuid\":\"a1\",\"session_id\":\"inner-tc\",\"message\":{\"id\":\"m1\",\"model\":\"claude-opus-5-5\",\"content\":[{\"type\":\"text\",\"text\":\"TC_ANSWER\"}]}}'\n" +
		"printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"inner-tc\",\"stop_reason\":\"end_turn\"}'\n" +
		"for i in $(seq 1 300); do [ -n \"$MAGPIE_TC_GATE\" ] && [ -f \"$MAGPIE_TC_GATE\" ] && break; sleep 0.1; done\n"
}

// tcMarkScript emits a complete reply then sleeps holding the reaper,
// exactly like the real wrapper's EXIT_HOLD window; the marker file
// proves the wrapper is still inside its hold.
func tcMarkScript(markEnv string) string {
	return "#!/bin/sh\n" +
		"cat >/dev/null\n" +
		"printf '%s\\n' '{\"type\":\"assistant\",\"uuid\":\"a1\",\"session_id\":\"inner-tc\",\"message\":{\"id\":\"m1\",\"model\":\"claude-opus-5-5\",\"content\":[{\"type\":\"text\",\"text\":\"TC_ANSWER\"}]}}'\n" +
		"printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"inner-tc\",\"stop_reason\":\"end_turn\"}'\n" +
		"printf held > \"${" + markEnv + "}\"\n" +
		"for i in $(seq 1 300); do [ -n \"$MAGPIE_TC_GATE\" ] && [ -f \"$MAGPIE_TC_GATE\" ] && break; sleep 0.1; done\n"
}

// tcParkScript emits one client tool_use row and stays alive parked: the
// run is genuinely waiting on tool results and must keep the outer.
func tcParkScript() string {
	return "#!/bin/sh\n" +
		"cat >/dev/null\n" +
		"printf '%s\\n' '{\"type\":\"assistant\",\"uuid\":\"t1\",\"session_id\":\"inner-tc\",\"message\":{\"id\":\"m1\",\"model\":\"claude-opus-5-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"mcp__magpie__write_file\",\"input\":{\"path\":\"a\"}}]}}'\n" +
		"printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"inner-tc\",\"stop_reason\":\"tool_use\"}'\n" +
		"sleep 30\n"
}

// tcFailScript ends the turn with an error result row.
func tcFailScript() string {
	return "#!/bin/sh\n" +
		"cat >/dev/null\n" +
		"printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"inner-tc\",\"is_error\":true,\"result\":\"wrapper exploded\",\"stop_reason\":\"error\"}'\n" +
		"sleep 30\n"
}

// tcROToolScript is a read-only-recovery turn that emits a forbidden
// tool_use row before its terminal result: the run must end failed and
// the checkpoint must stay dirty.
func tcROToolScript() string {
	return "#!/bin/sh\n" +
		"cat >/dev/null\n" +
		"printf '%s\\n' '{\"type\":\"assistant\",\"uuid\":\"r1\",\"session_id\":\"inner-tc\",\"message\":{\"id\":\"m\",\"model\":\"claude-opus-5-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"forged\",\"name\":\"mcp__magpie__write_file\",\"input\":{}}]}}'\n" +
		"printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"inner-tc\",\"stop_reason\":\"end_turn\"}'\n" +
		"sleep 30\n"
}

func tcDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "xdg"))
	return dir
}

func tcServe(t *testing.T, rt *runtimeTUI, b *subscriptionBridge, owner, outer string, body []byte) (int, string, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(string(body)))
	code, msg := rt.serveMessagesInner(rec, req, protoAnthropic, "Claude Code", "claude-opus-5-5", owner, outer, body, &Usage{},
		func(c context.Context, r *Request) (*subscriptionRun, <-chan Event, error) {
			return b.startInteractiveRequest(c, r, "claude-opus-5-5", "", owner, outer)
		})
	return code, msg, rec.Body.String()
}

func tcLaunchCount(t *testing.T, dir string) int {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "launches"))
	if err != nil {
		return 0
	}
	return strings.Count(string(b), "\n")
}

// tcScriptEnv points the dispatcher at one script per turn; gate names a
// file that releases the wrapper's hold.
func tcScriptEnv(t *testing.T, dir, script string, gateEnv string) {
	t.Helper()
	t.Setenv("MAGPIE_TC_SCRIPT", script)
	if gateEnv != "" {
		t.Setenv("MAGPIE_TC_GATE", filepath.Join(dir, gateEnv))
	} else {
		os.Unsetenv("MAGPIE_TC_GATE")
	}
}

// DAV-1888 core regression: a complete terminal reply whose clean
// checkpoint was saved, but whose wrapper is still inside its tmux
// EXIT_HOLD teardown, must not refuse the next canonical turn. The next
// request waits for the owner to be reaped, then starts and resumes.
func TestTerminalCleanupWaitedRunLetsNextTurnResume(t *testing.T) {
	dir := tcDir(t)
	tcWrapper(t, dir)
	b := newSubscriptionBridge()
	defer bridges.Delete(b)
	rt := &runtimeTUI{bridge: b}
	owner, outer := "owner-tc", "outer-tc"

	// Turn 1: first canonical turn, complete reply, wrapper still holding
	// the child in teardown (a real PTY wrapper's EXIT_HOLD window).
	mark := filepath.Join(dir, "turn1-held")
	t.Setenv("MAGPIE_TC_MARK1", mark)
	first := tcScript(t, dir, "turn1", "#!/bin/sh\n"+
		"cat >/dev/null\n"+
		"printf '%s\\n' '{\"type\":\"assistant\",\"uuid\":\"a1\",\"session_id\":\"inner-tc1\",\"message\":{\"id\":\"m1\",\"model\":\"claude-opus-5-5\",\"content\":[{\"type\":\"text\",\"text\":\"TC_ONE\"}]}}'\n"+
		"printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"inner-tc1\",\"stop_reason\":\"end_turn\"}'\n"+
		"printf held > \"$MAGPIE_TC_MARK1\"\n"+
		"for i in $(seq 1 300); do [ -f \"$MAGPIE_TC_GATE\" ] && break; sleep 0.1; done\n")
	t.Setenv("MAGPIE_TC_GATE", filepath.Join(dir, "gate1"))
	tcScriptEnv(t, dir, first, "gate1")

	body1 := []byte(`{"model":"claude-opus-5-5","max_tokens":64,"messages":[{"role":"user","content":"turn one"}]}`)
	code, msg, out := tcServe(t, rt, b, owner, outer, body1)
	if code != 200 || !strings.Contains(out, "TC_ONE") {
		t.Fatalf("turn 1 failed: %d %s %s", code, msg, out)
	}
	// The reply was delivered and the clean checkpoint saved, but the
	// wrapper is provably still inside its teardown hold.
	if _, err := os.Stat(mark); err != nil {
		t.Fatalf("wrapper did not reach its hold window: %v", err)
	}
	if _, same := olLiveOuterRuns(b, outer); same != 1 {
		t.Fatalf("expected turn1 run still live in teardown (same=%d)", same)
	}
	saved, ok := b.interactiveSession(owner, outer)
	if !ok || saved.Dirty || saved.SessionID != "inner-tc1" {
		t.Fatalf("clean checkpoint was not saved: %+v ok=%v", saved, ok)
	}

	// Turn 2 arrives immediately — inside the hold window — with the same
	// conversation plus the new user message. It must wait for the owner
	// slot to free, then start a fresh run; never 409, never overlap.
	second := tcScript(t, dir, "turn2", "#!/bin/sh\n"+
		"cat >/dev/null\n"+
		"printf launch2 >> \""+filepath.Join(dir, "launches")+"\"; printf '\\n' >> \""+filepath.Join(dir, "launches")+"\"\n"+
		"printf '%s\\n' '{\"type\":\"assistant\",\"uuid\":\"a2\",\"session_id\":\"inner-tc2\",\"message\":{\"id\":\"m2\",\"model\":\"claude-opus-5-5\",\"content\":[{\"type\":\"text\",\"text\":\"TC_TWO\"}]}}'\n"+
		"printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"inner-tc2\",\"stop_reason\":\"end_turn\"}'\n"+
		"for i in $(seq 1 100); do [ -n \"$MAGPIE_TC_GATE2\" ] && [ -f \"$MAGPIE_TC_GATE2\" ] && break; sleep 0.1; done\n")
	t.Setenv("MAGPIE_TC_GATE2", filepath.Join(dir, "gate2"))
	tcScriptEnv(t, dir, second, "")

	type result struct {
		code int
		msg  string
		out  string
	}
	done := make(chan result, 1)
	go func() {
		c, m, o := tcServe(t, rt, b, owner, outer, []byte(`{"model":"claude-opus-5-5","max_tokens":64,"messages":[{"role":"user","content":"turn one"},{"role":"assistant","content":"TC_ONE"},{"role":"user","content":"turn two"}]}`))
		done <- result{c, m, o}
	}()
	// While turn 2 is queued waiting, release turn 1's teardown.
	time.Sleep(200 * time.Millisecond)
	if err := os.WriteFile(filepath.Join(dir, "gate1"), []byte("go"), 0o600); err != nil {
		t.Fatal(err)
	}
	var r2 result
	select {
	case r2 = <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("turn 2 did not complete after the owner slot was released")
	}
	if r2.code != 200 || !strings.Contains(r2.out, "TC_TWO") {
		t.Fatalf("turn 2 was refused instead of waiting for cleanup: %d %s %s", r2.code, r2.msg, r2.out)
	}
	// The new run only launched after the old owner slot was freed, and it
	// launched exactly one new wrapper (no second PTY overlap).
	if n := tcLaunchCount(t, dir); n != 1 {
		t.Fatalf("expected exactly one new wrapper launch, saw %d", n)
	}
	saved, _ = b.interactiveSession(owner, outer)
	if saved.SessionID != "inner-tc2" || saved.Dirty {
		t.Fatalf("turn2 did not replace the checkpoint: %+v", saved)
	}
	_ = os.WriteFile(filepath.Join(dir, "gate2"), []byte("go"), 0o600)
	b.abortAll()
}

// The same next-turn request must not spawn a second PTY while the owner
// is still held: point the next launch at a script that can never emit a
// result. If the fix ever let it start without waiting, the 15s window
// would lapse with no TC_TWO — here it must wait, then fail closed once
// the owner stays held past the bounded cleanup wait.
func TestTerminalCleanupWaitTimesOutUnreachedOwner(t *testing.T) {
	dir := tcDir(t)
	tcWrapper(t, dir)
	b := newSubscriptionBridge()
	defer bridges.Delete(b)
	rt := &runtimeTUI{bridge: b}
	owner, outer := "owner-tc", "outer-tc"

	// Turn 1 holds its owner slot ~30s (longer than the bounded cleanup
	// wait), reply already delivered, clean checkpoint saved.
	mark := filepath.Join(dir, "turn1-held")
	t.Setenv("MAGPIE_TC_MARK1", mark)
	t.Setenv("MAGPIE_TC_GATE", filepath.Join(dir, "gate-never"))
	first := tcScript(t, dir, "turn1", tcMarkScript("MAGPIE_TC_MARK1"))
	tcScriptEnv(t, dir, first, "")
	// keep GATE pointing at a file that never appears so turn1 holds
	t.Setenv("MAGPIE_TC_GATE", filepath.Join(dir, "gate-never"))
	body1 := []byte(`{"model":"claude-opus-5-5","max_tokens":64,"messages":[{"role":"user","content":"turn one"}]}`)
	code, _, out := tcServe(t, rt, b, owner, outer, body1)
	if code != 200 || !strings.Contains(out, "TC_ANSWER") {
		t.Fatalf("turn 1 failed: %d %s", code, out)
	}
	if _, err := os.Stat(mark); err != nil {
		t.Fatal(err)
	}

	// Turn 2: the owner stays held longer than the wait bound. The request
	// must fail closed, not 200, and must not leave a second live run.
	second := tcScript(t, dir, "turn2", "#!/bin/sh\ncat >/dev/null\nprintf launch2 >> \""+filepath.Join(dir, "launches")+"\"\nsleep 5\n")
	tcScriptEnv(t, dir, second, "")
	code2, _, _ := tcServe(t, rt, b, owner, outer, []byte(`{"model":"claude-opus-5-5","max_tokens":64,"messages":[{"role":"user","content":"turn one"},{"role":"assistant","content":"TC_ANSWER"},{"role":"user","content":"turn two"}]}`))
	if code2 != http.StatusConflict {
		t.Fatalf("terminal-cleanup busy timeout must fail closed with 409, got %d", code2)
	}
	if _, same := olLiveOuterRuns(b, outer); same != 1 {
		t.Fatalf("expected only the still-held first run (same=%d)", same)
	}
	if n := tcLaunchCount(t, dir); n != 0 {
		t.Fatalf("a second wrapper was launched during the held window: %d", n)
	}
	b.abortAll()
}

// The terminal-cleanup wait is bound by the request context: cancel the
// caller while it waits and the start fails without forcing the owner
// slot, without a second PTY and without clearing dirty.
func TestTerminalCleanupWaitCancelledKeepsOwner(t *testing.T) {
	dir := tcDir(t)
	tcWrapper(t, dir)
	b := newSubscriptionBridge()
	defer bridges.Delete(b)
	rt := &runtimeTUI{bridge: b}
	owner, outer := "owner-tc", "outer-tc"

	mark := filepath.Join(dir, "turn1-held")
	t.Setenv("MAGPIE_TC_MARK1", mark)
	first := tcScript(t, dir, "turn1", tcMarkScript("MAGPIE_TC_MARK1"))
	tcScriptEnv(t, dir, first, "")
	body1 := []byte(`{"model":"claude-opus-5-5","max_tokens":64,"messages":[{"role":"user","content":"turn one"}]}`)
	code, _, out := tcServe(t, rt, b, owner, outer, body1)
	if code != 200 || !strings.Contains(out, "TC_ANSWER") {
		t.Fatalf("turn 1 failed: %d %s", code, out)
	}
	if _, err := os.Stat(mark); err != nil {
		t.Fatalf("wrapper did not reach its hold window: %v", err)
	}

	// Turn 2 on a cancellable request context.
	ctx, cancel := context.WithCancel(context.Background())
	second := tcScript(t, dir, "turn2", tcAnswerScript())
	tcScriptEnv(t, dir, second, "")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(`{"model":"claude-opus-5-5","max_tokens":64,"messages":[{"role":"user","content":"turn one"},{"role":"assistant","content":"TC_ANSWER"},{"role":"user","content":"turn two"}]}`)).WithContext(ctx)
	done := make(chan int, 1)
	go func() {
		body, _ := io.ReadAll(req.Body)
		req2 := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(string(body))).WithContext(ctx)
		code, _ := rt.serveMessagesInner(rec, req2, protoAnthropic, "Claude Code", "claude-opus-5-5", owner, outer, body, &Usage{},
			func(c context.Context, r *Request) (*subscriptionRun, <-chan Event, error) {
				return b.startInteractiveRequest(c, r, "claude-opus-5-5", "", owner, outer)
			})
		done <- code
	}()
	time.Sleep(200 * time.Millisecond)
	cancel()
	var code2 int
	select {
	case code2 = <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("cancelled wait did not return")
	}
	if code2 == 200 {
		t.Fatalf("a cancelled wait still started a second PTY: %s", rec.Body.String())
	}
	if _, same := olLiveOuterRuns(b, outer); same != 1 {
		t.Fatalf("the old run lost its owner slot to a cancelled wait (same=%d)", same)
	}
	b.mu.Lock()
	liveOuter := b.liveOuter[interactiveSessionStateKey(owner, outer)]
	b.mu.Unlock()
	if liveOuter == nil {
		t.Fatal("cancelled wait force-released liveOuter")
	}
	b.abortAll()
}

// A parked run — live, waiting on unanswered client tool calls — is not a
// terminal-delivered run: a same-outer non-matching request stays 409.
func TestTerminalCleanupParkedRunStillRefuses(t *testing.T) {
	dir := tcDir(t)
	tcWrapper(t, dir)
	b := newSubscriptionBridge()
	defer bridges.Delete(b)
	rt := &runtimeTUI{bridge: b}
	owner, outer := "owner-tc", "outer-tc"
	tcScriptEnv(t, dir, tcScript(t, dir, "park", tcParkScript()), "")
	body1 := []byte(`{"model":"claude-opus-5-5","max_tokens":64,"tools":[{"name":"write_file","input_schema":{"type":"object"}}],"messages":[{"role":"user","content":"把结果写进 notes.txt"}]}`)
	code, _, out := tcServe(t, rt, b, owner, outer, body1)
	if code != 200 || !strings.Contains(out, `"type":"tool_use"`) {
		t.Fatalf("first turn did not park: %d %s", code, out)
	}
	// The park left no checkpoint and the run is still live: refuse.
	tcScriptEnv(t, dir, tcScript(t, dir, "next", tcAnswerScript()), "")
	code, msg, _ := tcServe(t, rt, b, owner, outer, body1)
	if code != http.StatusConflict {
		t.Fatalf("a parked run let a second canonical PTY start: %d %s", code, msg)
	}
	b.abortAll()
}

// A failed turn — error result, no clean reply — is not
// terminal-delivered: the checkpoint stays dirty.
func TestTerminalCleanupFailedRunStaysDirty(t *testing.T) {
	dir := tcDir(t)
	tcWrapper(t, dir)
	b := newSubscriptionBridge()
	defer bridges.Delete(b)
	rt := &runtimeTUI{bridge: b}
	owner, outer := "owner-tc", "outer-tc"
	olSave(t, b, owner, outer, "inner-tc", true)
	tcScriptEnv(t, dir, tcScript(t, dir, "fail", tcFailScript()), "")
	body := []byte(`{"model":"claude-opus-5-5","max_tokens":64,"messages":[{"role":"user","content":"先读一下配置"},{"role":"assistant","content":"配置已读"},{"role":"user","content":"/magpie-recover"}]}`)
	code, _, _ := tcServe(t, rt, b, owner, outer, body)
	if code == 200 {
		t.Fatalf("a failed wrapper turn returned 200")
	}
	saved, _ := b.interactiveSession(owner, outer)
	if !saved.Dirty {
		t.Fatal("a failed terminal turn cleared the dirty checkpoint")
	}
	b.abortAll()
}

// A read-only recovery run that saw a tool signal is a failed turn: the
// checkpoint must stay dirty and the run is not a waitable terminal run.
func TestTerminalCleanupReadOnlySignaledStaysDirty(t *testing.T) {
	dir := tcDir(t)
	tcWrapper(t, dir)
	b := newSubscriptionBridge()
	defer bridges.Delete(b)
	rt := &runtimeTUI{bridge: b}
	owner, outer := "owner-tc", "outer-tc"
	olSave(t, b, owner, outer, "inner-tc", true)
	tcScriptEnv(t, dir, tcScript(t, dir, "ro-tool", tcROToolScript()), "")
	body := []byte(`{"model":"claude-opus-5-5","max_tokens":64,"tools":[{"name":"write_file","description":"w","input_schema":{"type":"object"}}],"messages":[{"role":"user","content":"先读一下配置"},{"role":"assistant","content":[{"type":"tool_use","id":"c1","name":"write_file","input":{"path":"p"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"c1","content":"x"},{"type":"text","text":"/magpie-recover"}]}]}`)
	code, _, out := tcServe(t, rt, b, owner, outer, body)
	saved, _ := b.interactiveSession(owner, outer)
	if !saved.Dirty {
		t.Fatalf("a read-only turn that signaled a tool cleared dirty: %d %s", code, out)
	}
	b.abortAll()
}

// The wait must never produce two live runs on the same outer: while one
// request waits on terminal cleanup, a second concurrent canonical start
// still fails closed rather than queueing a second new PTY.
func TestTerminalCleanupConcurrentStartStaysExclusive(t *testing.T) {
	dir := tcDir(t)
	tcWrapper(t, dir)
	b := newSubscriptionBridge()
	defer bridges.Delete(b)
	rt := &runtimeTUI{bridge: b}
	owner, outer := "owner-tc", "outer-tc"

	mark := filepath.Join(dir, "turn1-held")
	t.Setenv("MAGPIE_TC_MARK1", mark)
	first := tcScript(t, dir, "turn1", tcMarkScript("MAGPIE_TC_MARK1"))
	tcScriptEnv(t, dir, first, "")
	body1 := []byte(`{"model":"claude-opus-5-5","max_tokens":64,"messages":[{"role":"user","content":"turn one"}]}`)
	code, _, out := tcServe(t, rt, b, owner, outer, body1)
	if code != 200 || !strings.Contains(out, "TC_ANSWER") {
		t.Fatalf("turn 1 failed: %d %s", code, out)
	}
	if _, err := os.Stat(mark); err != nil {
		t.Fatal(err)
	}
	var got atomic.Int32
	var wg sync.WaitGroup
	body2 := []byte(`{"model":"claude-opus-5-5","max_tokens":64,"messages":[{"role":"user","content":"turn one"},{"role":"assistant","content":"TC_ANSWER"},{"role":"user","content":"turn two"}]}`)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, _, _ := tcServe(t, rt, b, owner, outer, body2)
			got.Add(int32(c))
		}()
	}
	wg.Wait()
	if _, same := olLiveOuterRuns(b, outer); same > 1 {
		t.Fatalf("two live canonical runs on one outer (live=%d)", same)
	}
	if got.Load() == 0 {
		t.Fatal("no request ran")
	}
	b.abortAll()
}

// Explicit tool-free recovery preserves its original input even when import
// mode would page an ordinary prompt of the same size through a private tool.
func TestTerminalCleanupReadOnlyOversizedImportStaysToolFree(t *testing.T) {
	if runtimeGOOS() == "windows" {
		t.Skip("requires a Unix shell wrapper")
	}
	t.Setenv("MAGPIE_CLAUDE_HISTORY_IMPORT", "1")
	dir := tcDir(t)
	capture := filepath.Join(dir, "readonly-prompt")
	release := filepath.Join(dir, "readonly-release")
	t.Setenv("MAGPIE_TC_READONLY_CAPTURE", capture)
	t.Setenv("MAGPIE_TC_READONLY_RELEASE", release)
	olWrapper(t, dir, "tc-readonly-oversized", "#!/bin/sh\n"+
		"cat > \"$MAGPIE_TC_READONLY_CAPTURE\"\n"+
		"printf '%s\\n' '{\"type\":\"assistant\",\"uuid\":\"a1\",\"session_id\":\"inner-tc-readonly\",\"message\":{\"id\":\"m1\",\"model\":\"claude-opus-5-5\",\"content\":[{\"type\":\"text\",\"text\":\"READONLY_ANSWER\"}]}}'\n"+
		"printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"inner-tc-readonly\",\"stop_reason\":\"end_turn\"}'\n"+
		"while [ ! -f \"$MAGPIE_TC_READONLY_RELEASE\" ]; do sleep 0.02; done\n")
	b := newSubscriptionBridge()
	t.Cleanup(func() { bridges.Delete(b) })
	prompt := strings.Repeat("synthetic tool-free recovery context\n", interactiveHistoricalBootstrapMaxBytes/32+1)
	if len(prompt) <= interactiveHistoricalBootstrapMaxBytes {
		t.Fatal("synthetic recovery input must exceed the ordinary paste budget")
	}
	req := &Request{Model: olModel, Messages: []Message{{Role: "user", Parts: []Part{{Kind: Text, Text: prompt}}}}}
	run, events, err := b.startInteractiveWithPrompt(context.Background(), req, olModel, "", "owner-tc-readonly", "outer-tc-readonly", prompt, "", true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.WriteFile(release, []byte("release"), 0o600)
		run.abort()
	})
	limit := time.NewTimer(5 * time.Second)
	defer limit.Stop()
	var answered bool
readReply:
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				break readReply
			}
			if ev.Kind == KError || ev.Kind == KToolStart {
				t.Fatalf("tool-free recovery emitted an unexpected event: %+v", ev)
			}
			answered = answered || ev.Kind == KText && ev.Text == "READONLY_ANSWER"
		case <-limit.C:
			t.Fatal("synthetic tool-free recovery did not answer")
		}
	}
	if !answered {
		t.Fatal("tool-free recovery answer was missing")
	}
	got, err := os.ReadFile(capture)
	if err != nil || string(got) != prompt {
		t.Fatalf("tool-free recovery input changed: bytes=%d want=%d err=%v", len(got), len(prompt), err)
	}
	if strings.Contains(string(got), interactiveArchiveTool) {
		t.Fatal("tool-free recovery received private archive instructions")
	}
	toolJSON, err := os.ReadFile(filepath.Join(run.tmp, "tools.json"))
	if err != nil {
		t.Fatal(err)
	}
	var tools []bridgeTool
	if err := json.Unmarshal(toolJSON, &tools); err != nil || len(tools) != 0 {
		t.Fatalf("tool-free recovery offered tools: count=%d err=%v", len(tools), err)
	}
	run.mu.Lock()
	hasArchive, allowed := run.historyArchive != nil, len(run.tools)
	run.mu.Unlock()
	if hasArchive || allowed != 0 || req.historyArchive != nil {
		t.Fatalf("tool-free recovery retained private readers: archive=%t allowed=%d", hasArchive, allowed)
	}
	for _, name := range []string{interactiveArchiveTool, interactiveImageTool, "write_file"} {
		body, _ := json.Marshal(map[string]any{"tool_call_id": "readonly-probe", "name": name, "arguments": map[string]any{"page": 0}})
		callback := httptest.NewRequest(http.MethodPost, "/_magpie/claude-mcp/native", strings.NewReader(string(body)))
		callback.SetPathValue("token", run.token)
		response := httptest.NewRecorder()
		b.mcpCall(response, callback)
		var result mcpToolResult
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || response.Code != http.StatusOK || !result.IsError {
			t.Fatalf("tool-free recovery accepted callback %s: status=%d err=%v", name, response.Code, err)
		}
	}
}

// A wrapper that exits without a terminal row may leave a same-group child
// holding stdout. Reaping must reach the group cleanup before waiting for EOF.
func TestTerminalCleanupExitWithoutResultReapsInheritedOutput(t *testing.T) {
	if runtimeGOOS() == "windows" {
		t.Skip("requires a Unix shell and process group")
	}
	dir := tcDir(t)
	holderFile := filepath.Join(dir, "output-holder")
	t.Setenv("MAGPIE_TC_OUTPUT_HOLDER", holderFile)
	olWrapper(t, dir, "tc-inherited-output", "#!/bin/sh\n"+
		"cat >/dev/null\n"+
		"sleep 30 &\n"+
		"printf '%s\\n' \"$!\" > \"$MAGPIE_TC_OUTPUT_HOLDER\"\n"+
		"exit 0\n")
	b := newSubscriptionBridge()
	t.Cleanup(func() { bridges.Delete(b) })
	owner, outer := "owner-tc-inherited", "outer-tc-inherited"
	req := &Request{Model: olModel, Messages: []Message{{Role: "user", Parts: []Part{{Kind: Text, Text: "synthetic cleanup request"}}}}}
	run, events, err := b.startInteractiveWithPrompt(context.Background(), req, olModel, "", owner, outer, "synthetic cleanup request", "", false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		run.mu.Lock()
		tree := run.tree
		run.mu.Unlock()
		if tree != nil {
			tree.Kill()
		}
		select {
		case <-run.interactiveDone:
		case <-time.After(3 * time.Second):
			t.Error("synthetic output holder cleanup did not finish")
		}
	})
	deadline := time.Now().Add(2 * time.Second)
	for {
		if data, readErr := os.ReadFile(holderFile); readErr == nil {
			var holder int
			if _, err := fmt.Sscan(string(data), &holder); err != nil || holder < 1 {
				t.Fatalf("invalid synthetic output holder: %q", data)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("wrapper did not create its synthetic output holder")
		}
		time.Sleep(5 * time.Millisecond)
	}
	select {
	case <-run.interactiveDone:
	case <-time.After(3 * time.Second):
		t.Fatal("wrapper exit without a result stayed blocked behind inherited stdout")
	}
	var missingResult bool
	for ev := range events {
		if ev.Kind == KError && strings.Contains(ev.Text, "without a terminal result") {
			missingResult = true
		}
	}
	if !missingResult {
		t.Fatal("abnormal wrapper exit did not report the missing terminal result")
	}
	deadline = time.Now().Add(time.Second)
	for b.interactiveOuterOwner(owner, outer) != nil {
		if time.Now().After(deadline) {
			t.Fatal("reaped abnormal wrapper retained the outer owner")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !b.claimInteractiveOuterTurn(owner, outer) {
		t.Fatal("abnormal wrapper cleanup retained the HTTP turn claim")
	}
	b.releaseInteractiveOuterTurn(owner, outer)
}

// WaitDelay also bounds stdin copying when the wrapper exits before reading
// its prompt and its child explicitly retains the original input descriptor.
func TestTerminalCleanupExitWithInheritedStdinIsBounded(t *testing.T) {
	if runtimeGOOS() == "windows" {
		t.Skip("requires a Unix shell and inherited descriptors")
	}
	t.Setenv("MAGPIE_CLAUDE_HISTORY_IMPORT", "0")
	dir := tcDir(t)
	olWrapper(t, dir, "tc-inherited-input", "#!/bin/sh\n"+
		"exec 3<&0\n"+
		"sleep 30 <&3 3<&- &\n"+
		"exit 0\n")
	b := newSubscriptionBridge()
	t.Cleanup(func() { bridges.Delete(b) })
	owner, outer := "owner-tc-input", "outer-tc-input"
	req := &Request{Model: olModel, Messages: []Message{{Role: "user", Parts: []Part{{Kind: Text, Text: "synthetic input cleanup"}}}}}
	prompt := strings.Repeat("synthetic unread input\n", 1<<16)
	run, events, err := b.startInteractiveWithPrompt(context.Background(), req, olModel, "", owner, outer, prompt, "", false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		run.mu.Lock()
		tree := run.tree
		run.mu.Unlock()
		if tree != nil {
			tree.Kill()
		}
		select {
		case <-run.interactiveDone:
		case <-time.After(3 * time.Second):
			t.Error("synthetic input holder cleanup did not finish")
		}
	})
	select {
	case <-run.interactiveDone:
	case <-time.After(5 * time.Second):
		t.Fatal("wrapper exit stayed blocked by stdin copying after WaitDelay")
	}
	var missingResult bool
	for ev := range events {
		if ev.Kind == KError && strings.Contains(ev.Text, "without a terminal result") {
			missingResult = true
		}
	}
	if !missingResult {
		t.Fatal("incomplete input consumption hid the missing terminal result")
	}
	deadline := time.Now().Add(time.Second)
	for b.interactiveOuterOwner(owner, outer) != nil {
		if time.Now().After(deadline) {
			t.Fatal("bounded stdin cleanup retained the outer owner")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// Cancelling a next-turn wait must return while the old wrapper is still
// inside its SIGINT grace window, without releasing that wrapper's owner.
func TestTerminalCleanupLiteTurnCancelDuringAbort(t *testing.T) {
	if runtimeGOOS() == "windows" {
		t.Skip("requires a Unix shell and signal handler")
	}
	const childEnv = "MAGPIE_TEST_TERMINAL_CLEANUP_CANCEL_CHILD"
	if os.Getenv(childEnv) != "1" {
		ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
		defer cancel()
		child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestTerminalCleanupLiteTurnCancelDuringAbort$", "-test.count=1")
		child.Env = append(os.Environ(), childEnv+"=1")
		if output, err := child.CombinedOutput(); err != nil {
			t.Fatalf("isolated cancellation test: %v\n%s", err, output)
		}
		return
	}
	// The grace override is scoped to this process and lasts through abort cleanup.
	interactiveAbortGrace = 3 * time.Second
	dir := tcDir(t)
	interrupted := filepath.Join(dir, "interrupted")
	t.Setenv("MAGPIE_TC_INTERRUPTED", interrupted)
	olWrapper(t, dir, "tc-cancel-abort", "#!/bin/sh\n"+
		"trap 'printf interrupted > \"$MAGPIE_TC_INTERRUPTED\"' INT\n"+
		"cat >/dev/null\n"+
		"printf '%s\\n' '{\"type\":\"assistant\",\"uuid\":\"t1\",\"session_id\":\"inner-tc-cancel\",\"message\":{\"id\":\"m1\",\"model\":\"claude-opus-5-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"mcp__magpie__write_file\",\"input\":{\"path\":\"a\"}}]}}'\n"+
		"while [ ! -f \"$DAV1878_PARK_RELEASE\" ]; do sleep 0.02; done\n")
	b := newSubscriptionBridge()
	t.Cleanup(func() { bridges.Delete(b) })
	owner, outer := "owner-tc-cancel", "outer-tc-cancel"
	parked := olParkedFirstTurn(t, dir, &runtimeTUI{bridge: b}, b, owner, outer)
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan bool, 1)
	waitDone := make(chan struct{})
	go func() {
		defer close(waitDone)
		claimed := b.takeLiteTurn(ctx, owner, outer)
		if claimed {
			b.releaseInteractiveOuterTurn(owner, outer)
		}
		result <- claimed
	}()
	t.Cleanup(func() {
		cancel()
		_ = os.WriteFile(filepath.Join(dir, "release-"+outer), []byte("release"), 0o600)
		parked.mu.Lock()
		tree := parked.tree
		parked.mu.Unlock()
		if tree != nil {
			tree.Kill()
		}
		select {
		case <-parked.interactiveDone:
		case <-time.After(3 * time.Second):
			t.Error("synthetic cancelled wrapper cleanup did not finish")
		}
		select {
		case <-waitDone:
		case <-time.After(3 * time.Second):
			t.Error("cancelled next-turn waiter remained blocked")
		}
	})
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Stat(interrupted); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("next-turn cleanup did not interrupt the parked wrapper")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	select {
	case claimed := <-result:
		if claimed {
			t.Fatal("cancelled waiter acquired the next turn")
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("cancelled next-turn waiter blocked inside wrapper abort")
	}
	select {
	case <-parked.interactiveDone:
		t.Fatal("wrapper exited before its controlled grace window was released")
	default:
	}
	if b.interactiveOuterOwner(owner, outer) != parked {
		t.Fatal("cancelled waiter released the still-running wrapper's owner")
	}
	if !b.claimInteractiveOuterTurn(owner, outer) {
		t.Fatal("cancelled waiter retained the HTTP turn claim")
	}
	b.releaseInteractiveOuterTurn(owner, outer)
}
