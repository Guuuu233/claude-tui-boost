package bridge

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const scOwner = "claude-tui\x00default"
const scOuter = "5b0e2c7a9d4f61e8a3b2c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4"

// scWrapper stands in for the native PTY wrapper: it records each start's
// argv, prompt and — when it is told to --resume — the session file it
// would resume, then answers SC_ANSWER in text.
func scWrapper(t *testing.T) (string, func() []map[string]string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "xdg"))
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(dir, "claude"))
	logs := filepath.Join(dir, "log")
	if err := os.MkdirAll(logs, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SC_LOG", logs)
	script := `#!/bin/sh
d="$SC_LOG/run-$$"
mkdir -p "$d"
printf '%s\n' "$@" > "$d/argv"
cat > "$d/stdin"
sid=inner-sc
prev=""
for a in "$@"; do
  if [ "$prev" = "--resume" ]; then
    sid="$a"; echo "$a" > "$d/resume"
    for f in "$CLAUDE_CONFIG_DIR"/projects/*/"$a".jsonl; do [ -f "$f" ] && cp "$f" "$d/seed.jsonl"; done
  fi
  prev="$a"
done
printf '%s\n' '{"type":"assistant","uuid":"a1","session_id":"'$sid'","message":{"id":"m1","model":"claude-opus-5-5","content":[{"type":"text","text":"SC_ANSWER"}]}}'
printf '%s\n' '{"type":"result","session_id":"'$sid'","stop_reason":"end_turn"}'
`
	p := filepath.Join(dir, "sc-bridge")
	if err := os.WriteFile(p, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv(interactiveBridgeEnv, p)
	return logs, func() []map[string]string {
		entries, _ := os.ReadDir(logs)
		var runs []map[string]string
		for _, e := range entries {
			run := map[string]string{}
			for _, name := range []string{"argv", "stdin", "resume", "seed.jsonl"} {
				if b, err := os.ReadFile(filepath.Join(logs, e.Name(), name)); err == nil {
					run[name] = strings.TrimSpace(string(b))
				}
			}
			runs = append(runs, run)
		}
		return runs
	}
}

func scRuntime(t *testing.T) (*runtimeTUI, *subscriptionBridge) {
	t.Helper()
	b := newSubscriptionBridge()
	t.Cleanup(func() { b.abortAll(); bridges.Delete(b) })
	return &runtimeTUI{bridge: b}, b
}

func scServe(t *testing.T, rt *runtimeTUI, outer, body string) (int, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body))
	code, _ := rt.serveMessages(rec, req, "claude-opus-5-5", outer, []byte(body), &Usage{})
	return code, rec.Body.String()
}

// scSaveClean writes a clean checkpoint for the two-message base history.
func scSaveClean(t *testing.T, b *subscriptionBridge, session string, dirty bool) {
	t.Helper()
	base := []Message{
		{Role: "user", Parts: []Part{{Kind: Text, Text: "先读一下配置"}}},
		{Role: "assistant", Parts: []Part{{Kind: Text, Text: "配置已读"}}},
	}
	baseReq := &Request{Model: "claude-opus-5-5", Messages: base}
	keys := conversationKeys(scOwner, base)
	if err := b.saveInteractiveSession(scOwner, scOuter, interactiveSessionEntry{
		SessionID: session, Model: "claude-opus-5-5", ThreadKey: firstWords(baseReq),
		ConvKey: keys[0], ReplyKey: assistantReplyKey(base[1]),
		ContextKey: turnKey(scOwner, baseReq, nil), Dirty: dirty,
	}); err != nil {
		t.Fatal(err)
	}
}

func onlyRun(t *testing.T, runs []map[string]string) map[string]string {
	t.Helper()
	if len(runs) != 1 {
		t.Fatalf("%d native starts, want 1: %v", len(runs), runs)
	}
	return runs[0]
}

// The request that continues its clean checkpoint exactly resumes that
// native session with only the new turn: no rebuild.
func TestLiteExactCheckpointResumes(t *testing.T) {
	_, runs := scWrapper(t)
	rt, b := scRuntime(t)
	scSaveClean(t, b, "inner-saved", false)
	code, out := scServe(t, rt, scOuter, `{"model":"claude-opus-5-5","max_tokens":64,"messages":[
		{"role":"user","content":"先读一下配置"},{"role":"assistant","content":"配置已读"},{"role":"user","content":"再看日志"}]}`)
	if code != 200 || !strings.Contains(out, "SC_ANSWER") {
		t.Fatalf("exact continuation failed: %d %s", code, out)
	}
	run := onlyRun(t, runs())
	if run["resume"] != "inner-saved" || run["seed.jsonl"] != "" {
		t.Fatalf("did not resume the checkpointed session as is: %v", run)
	}
	if !strings.Contains(run["stdin"], "再看日志") || strings.Contains(run["stdin"], "先读一下配置") {
		t.Fatalf("the resumed turn was not just the new message: %q", run["stdin"])
	}
}

// A history Science rewrote (its own compaction, an edit) no longer
// follows the checkpoint. It is answered from a session rebuilt from that
// history — the 502 this used to be is gone.
func TestLiteRewrittenHistoryRebuildsInsteadOfRefusing(t *testing.T) {
	_, runs := scWrapper(t)
	rt, b := scRuntime(t)
	scSaveClean(t, b, "inner-saved", false)
	code, out := scServe(t, rt, scOuter, `{"model":"claude-opus-5-5","max_tokens":64,"messages":[
		{"role":"user","content":"<summary>之前读了配置并修了两处</summary>"},{"role":"assistant","content":"好的，基于摘要继续"},{"role":"user","content":"现在跑测试"}]}`)
	if code != 200 || !strings.Contains(out, "SC_ANSWER") {
		t.Fatalf("rewritten history was refused: %d %s", code, out)
	}
	run := onlyRun(t, runs())
	if run["resume"] == "" || run["resume"] == "inner-saved" {
		t.Fatalf("not a rebuilt session: %v", run)
	}
	seed := run["seed.jsonl"]
	if !strings.Contains(seed, "之前读了配置并修了两处") || !strings.Contains(seed, "好的，基于摘要继续") || strings.Contains(seed, "现在跑测试") {
		t.Fatalf("seed is not the history before the new turn: %s", seed)
	}
	if !strings.Contains(run["stdin"], "现在跑测试") {
		t.Fatalf("the new turn was not the prompt: %q", run["stdin"])
	}
	// The rebuilt session is the conversation's checkpoint now: the next
	// turn resumes it exactly.
	saved, ok, err := b.loadInteractiveSession(scOwner, scOuter)
	if err != nil || !ok || saved.Dirty || saved.SessionID != run["resume"] {
		t.Fatalf("the rebuilt session did not become the clean checkpoint: %+v ok=%t err=%v", saved, ok, err)
	}
}

// A turn cut off (client gone, quota, crash) leaves a dirty checkpoint;
// the next request is rebuilt from what Science has, not refused.
func TestLiteDirtyCheckpointRebuilds(t *testing.T) {
	_, runs := scWrapper(t)
	rt, b := scRuntime(t)
	scSaveClean(t, b, "inner-saved", true)
	code, out := scServe(t, rt, scOuter, `{"model":"claude-opus-5-5","max_tokens":64,"messages":[
		{"role":"user","content":"先读一下配置"},{"role":"assistant","content":"配置已读"},{"role":"user","content":"继续"}]}`)
	if code != 200 || !strings.Contains(out, "SC_ANSWER") {
		t.Fatalf("dirty checkpoint was refused: %d %s", code, out)
	}
	if run := onlyRun(t, runs()); run["resume"] == "inner-saved" || !strings.Contains(run["seed.jsonl"], "配置已读") {
		t.Fatalf("dirty session was resumed instead of rebuilt: %v", run)
	}
}

// Tool results whose native run is gone (a tool that ran longer than the
// run waited, a runtime restart) continue in a rebuilt session that sees
// its call answered — not the old 409 "no matching live MCP run".
func TestLiteOrphanToolResultRebuildsWithStructuredHistory(t *testing.T) {
	_, runs := scWrapper(t)
	rt, _ := scRuntime(t)
	code, out := scServe(t, rt, scOuter, `{"model":"claude-opus-5-5","max_tokens":64,
		"tools":[{"name":"Bash","input_schema":{"type":"object"}}],
		"messages":[
		{"role":"user","content":"跑一下分析脚本"},
		{"role":"assistant","content":[{"type":"text","text":"我来运行"},{"type":"tool_use","id":"toolu_run1","name":"Bash","input":{"cmd":"python analyze.py"}}]},
		{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_run1","content":"r2=0.93"}]}]}`)
	if code != 200 || !strings.Contains(out, "SC_ANSWER") {
		t.Fatalf("orphan tool result was refused: %d %s", code, out)
	}
	run := onlyRun(t, runs())
	seed := run["seed.jsonl"]
	for _, want := range []string{`"name":"mcp__magpie__Bash"`, `"tool_use_id":"toolu_run1"`, "r2=0.93", "跑一下分析脚本"} {
		if !strings.Contains(seed, want) {
			t.Fatalf("seed lacks %s: %s", want, seed)
		}
	}
	if !strings.Contains(run["stdin"], liteContinueText) {
		t.Fatalf("a results-only turn was not told to continue: %q", run["stdin"])
	}
	// The seed must not end on the user's message, or Claude Code answers it
	// itself ("No response requested.") into the reply.
	lines := strings.Split(seed, "\n")
	if last := lines[len(lines)-1]; !strings.Contains(last, `"type":"assistant"`) || !strings.Contains(last, liteResultsReceived) {
		t.Fatalf("seed does not end with an assistant row: %s", last)
	}
	if strings.Contains(run["argv"], "python analyze.py") || strings.Contains(run["stdin"], "python analyze.py") {
		t.Fatalf("the old tool call leaked into the new turn: %v", run)
	}
}

// Science's mid-turn message: it reports the tool calls it did not run as
// not_dispatched and sends the user's words beside them. With no live run
// both reach the rebuilt session — results in history, words as the turn.
func TestLiteInterjectionWithoutLiveRunKeepsTheUsersWords(t *testing.T) {
	_, runs := scWrapper(t)
	rt, _ := scRuntime(t)
	code, out := scServe(t, rt, scOuter, `{"model":"claude-opus-5-5","max_tokens":64,
		"tools":[{"name":"Bash","input_schema":{"type":"object"}}],
		"messages":[
		{"role":"user","content":"训练三个模型"},
		{"role":"assistant","content":[{"type":"tool_use","id":"toolu_a","name":"Bash","input":{"cmd":"train a"}},{"type":"tool_use","id":"toolu_b","name":"Bash","input":{"cmd":"train b"}}]},
		{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_a","content":"a done"},
			{"type":"tool_result","tool_use_id":"toolu_b","is_error":true,"content":"{\"status\":\"not_dispatched\"}"},
			{"type":"text","text":"先别训练 b，改成只比较 a"}]}]}`)
	if code != 200 || !strings.Contains(out, "SC_ANSWER") {
		t.Fatalf("interjection was refused: %d %s", code, out)
	}
	run := onlyRun(t, runs())
	if !strings.Contains(run["stdin"], "先别训练 b，改成只比较 a") || strings.Contains(run["stdin"], liteContinueText) {
		t.Fatalf("the user's words were not the turn: %q", run["stdin"])
	}
	if !strings.Contains(run["seed.jsonl"], "not_dispatched") || !strings.Contains(run["seed.jsonl"], "a done") {
		t.Fatalf("tool results missing from the seed: %s", run["seed.jsonl"])
	}
}

// A run parked on a tool call Science's next request does not answer (the
// user stopped, Science moved on) is stopped and the request answered —
// where Desktop's path refuses with 409 to protect a live tool.
func TestLiteNewTurnStopsAParkedRunInsteadOf409(t *testing.T) {
	dir := olDir(t)
	olWrapper(t, dir, "sc-park-bridge", olParkScript())
	rt, b := scRuntime(t)
	t.Setenv("DAV1878_PARK_RELEASE", filepath.Join(dir, "never"))
	first := `{"model":"claude-opus-5-5","max_tokens":64,"tools":[{"name":"write_file","input_schema":{"type":"object"}}],"messages":[{"role":"user","content":"把结果写进 notes.txt"}]}`
	if code, out := scServe(t, rt, scOuter, first); code != 200 || !strings.Contains(out, `"type":"tool_use"`) {
		t.Fatalf("first turn did not park: %d %s", code, out)
	}
	parked := b.interactiveOuterOwner(scOwner, scOuter)
	if parked == nil {
		t.Fatal("no parked run owns the conversation")
	}
	_, runs := scWrapper(t)
	code, out := scServe(t, rt, scOuter, `{"model":"claude-opus-5-5","max_tokens":64,"tools":[{"name":"write_file","input_schema":{"type":"object"}}],"messages":[
		{"role":"user","content":"把结果写进 notes.txt"},{"role":"assistant","content":"已停止"},{"role":"user","content":"算了，直接告诉我结果"}]}`)
	if code != 200 || !strings.Contains(out, "SC_ANSWER") {
		t.Fatalf("new turn on a parked conversation was refused: %d %s", code, out)
	}
	parked.mu.Lock()
	closed := parked.closed
	parked.mu.Unlock()
	if !closed {
		t.Fatal("the parked run was left alive beside the new one")
	}
	onlyRun(t, runs())
}

// A conversation still answering another request past the wait is told to
// retry: a second native run of one conversation is never started beside
// the first, and its checkpoint is untouched.
func TestLiteBusyConversationAsksForRetryAndStartsNothing(t *testing.T) {
	_, runs := scWrapper(t)
	rt, b := scRuntime(t)
	old := liteTurnWait
	liteTurnWait = 200 * time.Millisecond
	t.Cleanup(func() { liteTurnWait = old })
	scSaveClean(t, b, "inner-saved", false)
	before, _, _ := b.loadInteractiveSession(scOwner, scOuter)
	if !b.claimInteractiveOuterTurn(scOwner, scOuter) {
		t.Fatal("claim")
	}
	defer b.releaseInteractiveOuterTurn(scOwner, scOuter)
	rec := httptest.NewRecorder()
	body := `{"model":"claude-opus-5-5","max_tokens":64,"messages":[{"role":"user","content":"先读一下配置"},{"role":"assistant","content":"配置已读"},{"role":"user","content":"继续"}]}`
	code, _ := rt.serveMessages(rec, httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body)), "claude-opus-5-5", scOuter, []byte(body), &Usage{})
	if code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("busy conversation: %d retry-after=%q", code, rec.Header().Get("Retry-After"))
	}
	if n := len(runs()); n != 0 {
		t.Fatalf("%d native runs started for a busy conversation", n)
	}
	after, _, _ := b.loadInteractiveSession(scOwner, scOuter)
	if after != before {
		t.Fatalf("checkpoint changed: %+v -> %+v", before, after)
	}
}

// A request without a conversation id (helper calls such as memory
// extraction forks) runs on a session rebuilt from its own history and never
// touches any conversation's checkpoint.
func TestLiteStatelessRequestIsSeeded(t *testing.T) {
	_, runs := scWrapper(t)
	rt, b := scRuntime(t)
	scSaveClean(t, b, "inner-saved", false)
	before, _, _ := b.loadInteractiveSession(scOwner, scOuter)
	code, out := scServe(t, rt, "", `{"model":"claude-opus-5-5","max_tokens":64,"tool_choice":{"type":"none"},
		"tools":[{"name":"Bash","input_schema":{"type":"object"}}],
		"messages":[
		{"role":"user","content":"先读一下配置"},
		{"role":"assistant","content":[{"type":"tool_use","id":"toolu_r","name":"Bash","input":{"cmd":"cat cfg"}}]},
		{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_r","content":"k=v"}]},
		{"role":"assistant","content":"配置已读"},
		{"role":"user","content":"Extract durable memories from the conversation above."}]}`)
	if code != 200 || !strings.Contains(out, "SC_ANSWER") {
		t.Fatalf("fork failed: %d %s", code, out)
	}
	run := onlyRun(t, runs())
	if !strings.Contains(run["seed.jsonl"], "k=v") || !strings.Contains(run["stdin"], "Extract durable memories") {
		t.Fatalf("fork not seeded from its history: %v", run)
	}
	after, _, _ := b.loadInteractiveSession(scOwner, scOuter)
	if after != before {
		t.Fatalf("a helper call changed the conversation checkpoint: %+v -> %+v", before, after)
	}
	if b.interactiveOuterOwner(scOwner, scOuter) != nil {
		t.Fatal("a helper call took ownership of the conversation")
	}
}

func TestLitePairedToolTraffic(t *testing.T) {
	msgs := []Message{
		{Role: "user", Parts: []Part{{Kind: Text, Text: "go"}}},
		{Role: "assistant", Parts: []Part{{Kind: ToolCall, ID: "a", Name: "Bash"}, {Kind: ToolCall, ID: "lost", Name: "Bash"}}},
		{Role: "user", Parts: []Part{{Kind: ToolResult, CallID: "a", Text: "ok"}, {Kind: ToolResult, CallID: "stray", Text: "?"}}},
		{Role: "assistant", Parts: []Part{{Kind: ToolCall, ID: "unanswered", Name: "Bash"}}},
	}
	got, _ := json.Marshal(pairedToolTraffic(msgs))
	for _, gone := range []string{`"lost"`, `"stray"`, `"unanswered"`} {
		if strings.Contains(string(got), gone) {
			t.Fatalf("%s survived: %s", gone, got)
		}
	}
	if !strings.Contains(string(got), `"a"`) {
		t.Fatalf("the answered call was dropped: %s", got)
	}
}

// A helper call reusing the conversation id for another thread (Desktop
// titles, subagents) keeps upstream's routing: stateless, the checkpoint
// untouched.
func TestLiteOtherThreadOnTheConversationIdRunsStateless(t *testing.T) {
	_, runs := scWrapper(t)
	rt, b := scRuntime(t)
	scSaveClean(t, b, "inner-saved", false)
	b.anchorOuterThread(scOwner, scOuter, &Request{Messages: []Message{{Role: "user", Parts: []Part{{Kind: Text, Text: "先读一下配置"}}}}})
	before, _, _ := b.loadInteractiveSession(scOwner, scOuter)
	code, out := scServe(t, rt, scOuter, `{"model":"claude-opus-5-5","max_tokens":64,"messages":[
		{"role":"user","content":"Explore the repository and list its packages"},{"role":"assistant","content":"Looking"},{"role":"user","content":"go on"}]}`)
	if code != 200 || !strings.Contains(out, "SC_ANSWER") {
		t.Fatalf("helper: %d %s", code, out)
	}
	onlyRun(t, runs())
	after, _, _ := b.loadInteractiveSession(scOwner, scOuter)
	if after != before {
		t.Fatalf("a helper thread changed the conversation checkpoint: %+v -> %+v", before, after)
	}
}

// The conversation's own next request that does not carry the parked run's
// tool call (its client never received it: the reply was cut off, and the
// turn is sent again) stops the parked run; exactly one native run is left.
func TestLiteRetriedTurnStopsTheParkedRunItNeverSaw(t *testing.T) {
	dir := olDir(t)
	olWrapper(t, dir, "lite-park-bridge", olParkScript())
	rt, b := scRuntime(t)
	t.Setenv("DAV1878_PARK_RELEASE", filepath.Join(dir, "never"))
	first := `{"model":"claude-opus-5-5","max_tokens":64,"tools":[{"name":"write_file","input_schema":{"type":"object"}}],"messages":[{"role":"user","content":"把结果写进 notes.txt"}]}`
	if code, out := scServe(t, rt, scOuter, first); code != 200 || !strings.Contains(out, `"type":"tool_use"`) {
		t.Fatalf("first turn did not park: %d %s", code, out)
	}
	parked := b.interactiveOuterOwner(scOwner, scOuter)
	if parked == nil {
		t.Fatal("no parked run")
	}
	_, runs := scWrapper(t)
	code, out := scServe(t, rt, scOuter, first)
	if code != 200 || !strings.Contains(out, "SC_ANSWER") {
		t.Fatalf("retried turn: %d %s", code, out)
	}
	parked.mu.Lock()
	closed := parked.closed
	parked.mu.Unlock()
	if !closed {
		t.Fatal("the parked run was left alive beside the retried turn")
	}
	onlyRun(t, runs())
	if _, same := olLiveOuterRuns(b, scOuter); same > 1 {
		t.Fatalf("%d live runs on one conversation", same)
	}
}

// Claude Code reports a reached usage limit as a synthetic API error with the
// generic 502; clients must see 429 so they wait instead of retrying at once.
func TestLiteUsageLimitIs429(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "xdg"))
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(dir, "claude"))
	p := filepath.Join(dir, "limit-bridge")
	os.WriteFile(p, []byte("#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '{\"type\":\"assistant\",\"isApiErrorMessage\":true,\"session_id\":\"s\",\"message\":{\"model\":\"<synthetic>\",\"content\":[{\"type\":\"text\",\"text\":\"You have hit your session limit \u00b7 resets 5am (UTC)\"}]}}'\nprintf '%s\\n' '{\"type\":\"result\",\"session_id\":\"s\",\"is_error\":true,\"result\":\"You have hit your session limit\"}'\n"), 0o700)
	t.Setenv(interactiveBridgeEnv, p)
	rt, _ := scRuntime(t)
	for _, stream := range []string{"true", "false"} {
		code, out := scServe(t, rt, scOuter, `{"model":"claude-opus-5-5","max_tokens":64,"stream":`+stream+`,"messages":[{"role":"user","content":"hi"}]}`)
		if code != http.StatusTooManyRequests || !strings.Contains(out, "session limit") {
			t.Fatalf("stream=%s: usage limit answered %d %s", stream, code, out)
		}
	}
	if liteStatus(http.StatusBadGateway, "prompt is too long: exceeded context") != http.StatusBadGateway {
		t.Fatal("a context overflow was taken for a usage limit")
	}
	if liteStatus(http.StatusBadRequest, "rate limit") != http.StatusBadRequest {
		t.Fatal("a definite status was overridden")
	}
}

// The plugin's stateless marker reaches serveMessages as no conversation.
func TestLiteSignedStatelessSessionHasNoConversation(t *testing.T) {
	if statelessSession != "stateless" {
		t.Fatal("the plugin and runtime must agree on the stateless marker")
	}
}
