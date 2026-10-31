package bridge

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func resetRebuildMarks(t *testing.T) {
	t.Helper()
	reset := func() {
		rebuildMarks.Lock()
		rebuildMarks.written = map[string]time.Time{}
		rebuildMarks.Unlock()
		rebuildMarksOff.Store(false)
	}
	reset()
	t.Cleanup(reset)
}

func textMsg(role, text string) Message {
	return Message{Role: role, Parts: []Part{{Kind: Text, Text: text}}}
}

// ledgerHistory is n user/assistant pairs: 2n lookback positions.
func ledgerHistory(from, n int) []Message {
	var out []Message
	for i := from; i < from+n; i++ {
		out = append(out, textMsg("user", fmt.Sprintf("batch %d rows", i)), textMsg("assistant", fmt.Sprintf("recorded %d", i)))
	}
	return out
}

// markedBlocks reads a transcript and returns, per row, the indexes of its
// content blocks that carry cache_control (and that control).
func markedBlocks(t *testing.T, path string) (rows int, marked map[int][]int, controls []map[string]any) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	marked = map[int][]int{}
	s := bufio.NewScanner(f)
	s.Buffer(make([]byte, 1<<20), 1<<24)
	for s.Scan() {
		var row struct {
			Message struct {
				Content []map[string]any `json:"content"`
			} `json:"message"`
		}
		if err := json.Unmarshal(s.Bytes(), &row); err != nil {
			t.Fatal(err)
		}
		for j, b := range row.Message.Content {
			if c, ok := b["cache_control"].(map[string]any); ok {
				marked[rows] = append(marked[rows], j)
				controls = append(controls, c)
			}
		}
		rows++
	}
	return rows, marked, controls
}

func TestRebuildCacheMarkIsTheLastClientBlockForAnHour(t *testing.T) {
	resetRebuildMarks(t)
	history := ledgerHistory(0, 3)
	mark, ok := rebuildCacheMark("ctx", history, "mcp__magpie__")
	if !ok || mark != (transcriptMark{5, 0}) {
		t.Fatalf("mark %+v %t, want the last reply", mark, ok)
	}
	work := t.TempDir()
	config := t.TempDir()
	_, path, err := writeClaudeTranscript(work, config, "claude-opus-5-5", nil, history, "mcp__magpie__", "", mark)
	if err != nil {
		t.Fatal(err)
	}
	rows, marked, controls := markedBlocks(t, path)
	if rows != 6 || len(marked) != 1 || len(marked[5]) != 1 || marked[5][0] != 0 {
		t.Fatalf("marked blocks %v of %d rows, want only row 5 block 0", marked, rows)
	}
	if controls[0]["type"] != "ephemeral" || controls[0]["ttl"] != "1h" {
		t.Fatalf("cache_control %v, want an hour's ephemeral mark", controls[0])
	}
}

// A history ending in tool results closes with liteResultsReceived, which
// the next rebuild will not have: the results are marked, once per run.
func TestRebuildCacheMarkSkipsTheResultsClosing(t *testing.T) {
	resetRebuildMarks(t)
	history := []Message{
		textMsg("user", "run both"),
		{Role: "assistant", Parts: []Part{{Kind: Text, Text: "running"}, {Kind: ToolCall, ID: "a", Name: "Bash", Args: json.RawMessage(`{"cmd":"a"}`)}, {Kind: ToolCall, ID: "b", Name: "Bash", Args: json.RawMessage(`{"cmd":"b"}`)}}},
		{Role: "user", Parts: []Part{{Kind: ToolResult, CallID: "a", Text: "A"}, {Kind: ToolResult, CallID: "b", Text: "B"}}},
		textMsg("assistant", liteResultsReceived),
	}
	mark, ok := rebuildCacheMark("ctx", history, "mcp__magpie__")
	if !ok || mark != (transcriptMark{2, 1}) {
		t.Fatalf("mark %+v %t, want the last tool result", mark, ok)
	}
}

func TestRebuildCacheMarkPassesOverThinkingAndEmptyText(t *testing.T) {
	resetRebuildMarks(t)
	history := []Message{
		textMsg("user", "question"),
		{Role: "assistant", Parts: []Part{{Kind: Text, Text: "answer"}, {Kind: Thinking, Text: "hidden"}, {Kind: Text, Text: "  "}}},
	}
	if mark, ok := rebuildCacheMark("ctx", history, ""); !ok || mark != (transcriptMark{1, 0}) {
		t.Fatalf("mark %+v %t, want the non-empty text", mark, ok)
	}
}

// Within Anthropic's lookback the next rebuild marks its own last block;
// past it, the mark steps from the earlier one, which it can still read.
func TestRebuildCacheMarkStepsWithinTheLookback(t *testing.T) {
	resetRebuildMarks(t)
	first := ledgerHistory(0, 10) // positions 1..20
	if mark, ok := rebuildCacheMark("ctx", first, ""); !ok || mark.msg != 19 {
		t.Fatalf("first mark %+v %t, want the last reply", mark, ok)
	}
	near := append(append([]Message(nil), first...), ledgerHistory(10, 4)...) // +8 positions
	if mark, ok := rebuildCacheMark("ctx", near, ""); !ok || mark.msg != len(near)-1 {
		t.Fatalf("near mark %+v %t, want the last reply", mark, ok)
	}
	far := append(append([]Message(nil), near...), ledgerHistory(14, 15)...) // +30 positions past the near mark
	mark, ok := rebuildCacheMark("ctx", far, "")
	// The near mark is at position 28 (message 27): reach 18 allows up to
	// position 46, the reply at message 45.
	if !ok || mark.msg != 45 {
		t.Fatalf("far mark %+v %t, want message 45, 18 positions on", mark, ok)
	}
	// The same history again reads that step and goes on to its end.
	if mark, ok := rebuildCacheMark("ctx", far, ""); !ok || mark.msg != len(far)-1 {
		t.Fatalf("repeat mark %+v %t, want the last reply", mark, ok)
	}
}

// Consecutive tool calls (or results) are one lookback position.
func TestRebuildCacheMarkCountsToolRunsAsOnePosition(t *testing.T) {
	resetRebuildMarks(t)
	base := ledgerHistory(0, 2) // positions 1..4, mark at message 3
	if _, ok := rebuildCacheMark("ctx", base, ""); !ok {
		t.Fatal("no base mark")
	}
	history := append([]Message(nil), base...)
	for i := 0; i < 6; i++ { // each round: text, 3 calls, 3 results = 3 positions
		var calls, results []Part
		for k := 0; k < 3; k++ {
			id := fmt.Sprintf("c%d-%d", i, k)
			calls = append(calls, Part{Kind: ToolCall, ID: id, Name: "Read", Args: json.RawMessage(`{}`)})
			results = append(results, Part{Kind: ToolResult, CallID: id, Text: "ok"})
		}
		history = append(history,
			Message{Role: "assistant", Parts: append([]Part{{Kind: Text, Text: "reading"}}, calls...)},
			Message{Role: "user", Parts: results})
	}
	history = append(history, textMsg("assistant", liteResultsReceived))
	// 18 positions after the base mark: still within reach, so the end.
	mark, ok := rebuildCacheMark("ctx", history, "")
	if !ok || mark != (transcriptMark{len(history) - 2, 2}) {
		t.Fatalf("mark %+v %t, want the last result of the last run", mark, ok)
	}
}

func TestRebuildCacheMarkKeepsConversationsApart(t *testing.T) {
	resetRebuildMarks(t)
	first := ledgerHistory(0, 10)
	if _, ok := rebuildCacheMark("ctx-a", first, ""); !ok {
		t.Fatal("no mark")
	}
	far := append(append([]Message(nil), first...), ledgerHistory(10, 15)...)
	// Another context never wrote the earlier entry: mark the end.
	if mark, ok := rebuildCacheMark("ctx-b", far, ""); !ok || mark.msg != len(far)-1 {
		t.Fatalf("mark %+v %t, want the end for an unrelated context", mark, ok)
	}
}

func TestRebuildCacheMarkCanBeTurnedOff(t *testing.T) {
	resetRebuildMarks(t)
	t.Setenv("MAGPIE_CLAUDE_REBUILD_CACHE_MARK", "0")
	if _, ok := rebuildCacheMark("ctx", ledgerHistory(0, 2), ""); ok {
		t.Fatal("marked although turned off")
	}
}

func TestRebuildCacheMarkStopsAfterARefusal(t *testing.T) {
	resetRebuildMarks(t)
	noteRebuildMarkRefused("API Error: 400 overloaded")
	if !rebuildMarksEnabled() {
		t.Fatal("an unrelated error turned the marks off")
	}
	noteRebuildMarkRefused("API Error: 400 A maximum of 4 blocks with cache_control may be provided. Found 5.")
	if _, ok := rebuildCacheMark("ctx", ledgerHistory(0, 2), ""); ok {
		t.Fatal("marked after Anthropic refused the marks")
	}
}

// End to end through serveMessages: a rebuilt session's seed carries
// exactly one mark, on the history's own last block, and the next rebuild
// of the grown conversation marks its own end.
func TestLiteRebuildSeedCarriesOneCacheMark(t *testing.T) {
	resetRebuildMarks(t)
	_, runs := scWrapper(t)
	rt, _ := scRuntime(t)
	code, out := scServe(t, rt, "", `{"model":"claude-opus-5-5","max_tokens":64,"messages":[
		{"role":"user","content":"先读一下配置"},{"role":"assistant","content":"配置已读"},
		{"role":"user","content":"再看日志\n\n[Mixture of Agents reference context]\nAdvice A"}]}`)
	if code != 200 || !strings.Contains(out, "SC_ANSWER") {
		t.Fatalf("stateless rebuild failed: %d %s", code, out)
	}
	code, out = scServe(t, rt, "", `{"model":"claude-opus-5-5","max_tokens":64,"messages":[
		{"role":"user","content":"先读一下配置"},{"role":"assistant","content":"配置已读"},
		{"role":"user","content":"再看日志"},{"role":"assistant","content":"日志正常"},
		{"role":"user","content":"总结\n\n[Mixture of Agents reference context]\nAdvice B"}]}`)
	if code != 200 || !strings.Contains(out, "SC_ANSWER") {
		t.Fatalf("second stateless rebuild failed: %d %s", code, out)
	}
	all := runs()
	if len(all) != 2 {
		t.Fatalf("%d native starts, want 2", len(all))
	}
	var seeds []string
	for _, r := range all {
		seeds = append(seeds, r["seed.jsonl"])
	}
	for i, want := range []string{"配置已读", "日志正常"} {
		var hit string
		for _, s := range seeds {
			if strings.Count(s, `"cache_control"`) != 1 {
				t.Fatalf("seed has %d marks, want 1: %s", strings.Count(s, `"cache_control"`), s)
			}
			if strings.Contains(s, "Advice A") {
				t.Fatalf("an earlier turn's advice reached a rebuilt seed: %s", s)
			}
			lines := strings.Split(strings.TrimSpace(s), "\n")
			if last := lines[len(lines)-1]; strings.Contains(last, want) && strings.Contains(last, `"ttl":"1h"`) {
				hit = last
			}
		}
		if hit == "" {
			t.Fatalf("seed %d does not mark its last reply %q: %v", i, want, seeds)
		}
	}
}

func TestLiteToolResultRebuildMarksTheResultNotTheClosing(t *testing.T) {
	resetRebuildMarks(t)
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
	seed := onlyRun(t, runs())["seed.jsonl"]
	lines := strings.Split(strings.TrimSpace(seed), "\n")
	if len(lines) < 2 || strings.Count(seed, `"cache_control"`) != 1 {
		t.Fatalf("seed marks %d blocks, want 1: %s", strings.Count(seed, `"cache_control"`), seed)
	}
	results, closing := lines[len(lines)-2], lines[len(lines)-1]
	if !strings.Contains(results, `"tool_result"`) || !strings.Contains(results, `"cache_control"`) || strings.Contains(closing, `"cache_control"`) {
		t.Fatalf("mark is not on the tool result:\n%s\n%s", results, closing)
	}
}

// The compaction archive is not a rebuilt session: it stays unmarked.
func TestCompactionTranscriptCarriesNoCacheMark(t *testing.T) {
	resetRebuildMarks(t)
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	req := &Request{Model: "claude-opus-5-5", compactHistory: ledgerHistory(0, 3), compactSystem: "be brief"}
	_, path, err := writeCompactionTranscript(t.TempDir(), "", req)
	if err != nil {
		t.Fatal(err)
	}
	if _, marked, _ := markedBlocks(t, path); len(marked) != 0 {
		t.Fatalf("compaction transcript marked: %v", marked)
	}
}
