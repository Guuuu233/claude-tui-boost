package bridge

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// A past regression expanded a ~500k context into >1m tokens by flattening
// images, tool history and JSON into the inner Claude prompt. This fixture
// verifies the *wire payload*, not an invented token-equivalence claim.
// The archived conversation must remain structured, complete and separate
// from the single short summarization instruction. No tool is executed.
func TestCompactionLargeHistoricalTranscriptPreservesStructureWithoutTextExpansion(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	const chunk = "留存 ARCHIVE_SENTINEL αβγ 12345\n"
	const repetitions = 34000 // deliberately above 512 KiB of UTF-8 text
	bigText := strings.Repeat(chunk, repetitions)
	imageData := strings.Repeat("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=", 5000)
	oldArgs := json.RawMessage(`{"command":"SYNTHETIC_TOOL_MUST_NOT_RUN", "path":"/test/only"}`)
	req := &Request{
		Model: "claude-opus-5-5", System: compactSystemTest,
		Tools: []Tool{{Name: "Bash"}},
		Messages: []Message{
			{Role: "user", Parts: []Part{{Kind: Text, Text: bigText}}},
			{Role: "assistant", Parts: []Part{{Kind: ToolCall, ID: "historical-call", Name: "Bash", Args: oldArgs}}},
			{Role: "user", Parts: []Part{
				{Kind: ToolResult, CallID: "historical-call", Text: "SYNTHETIC_RESULT", Images: []Part{{Kind: Image, MediaType: "image/png", Data: imageData}}},
				{Kind: Text, Text: "Your task is to create a detailed summary of the conversation so far."},
			}},
		},
	}
	summary := claudeDesktopCompactionRequest(req)
	if len(summary.Tools) != 0 || len(summary.Messages) != 1 || summary.Messages[0].Parts[0].Kind != Text {
		t.Fatal("compaction was not stripped down to a single tool-free summary request")
	}
	textInstruction := summary.Messages[0].Parts[0].Text
	if len(textInstruction) > 2048 || strings.Contains(textInstruction, bigText[:300]) || strings.Contains(textInstruction, imageData[:120]) || strings.Contains(textInstruction, "SYNTHETIC_TOOL_MUST_NOT_RUN") {
		t.Fatal("archived content was flattened or duplicated into the summarizer prompt")
	}
	_, path, err := writeCompactionTranscript(t.TempDir(), "", summary)
	if err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	scan := bufio.NewScanner(file)
	scan.Buffer(make([]byte, 64*1024), len(bigText)+len(imageData)+1024*1024)
	type contentRow struct {
		Type    string `json:"type"`
		Message struct {
			Content []map[string]json.RawMessage `json:"content"`
		} `json:"message"`
	}
	var rows []contentRow
	for scan.Scan() {
		var row contentRow
		if err := json.Unmarshal(scan.Bytes(), &row); err != nil {
			t.Fatal(err)
		}
		rows = append(rows, row)
	}
	if err := scan.Err(); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 5 { // archived system, original 3 rows, archival-complete assistant
		t.Fatalf("expected five structured rows, got %d", len(rows))
	}
	var archivedText string
	if err := json.Unmarshal(rows[1].Message.Content[0]["text"], &archivedText); err != nil || archivedText != bigText {
		t.Fatalf("large historical text not preserved byte-for-byte: read=%d expected=%d err=%v", len(archivedText), len(bigText), err)
	}
	var callName string
	if err := json.Unmarshal(rows[2].Message.Content[0]["name"], &callName); err != nil || callName != "Bash" {
		t.Fatalf("historical tool was not preserved as inert structured data: %q %v", callName, err)
	}
	var blocks []map[string]json.RawMessage
	if err := json.Unmarshal(rows[3].Message.Content[0]["content"], &blocks); err != nil {
		t.Fatal(err)
	}
	var source map[string]json.RawMessage
	if err := json.Unmarshal(blocks[1]["source"], &source); err != nil {
		t.Fatal(err)
	}
	var archivedImage string
	if err := json.Unmarshal(source["data"], &archivedImage); err != nil || archivedImage != imageData {
		t.Fatalf("historical image mutated: read=%d expected=%d err=%v", len(archivedImage), len(imageData), err)
	}
	if bytes.Contains([]byte(summary.Messages[0].Parts[0].Text), []byte("SYNTHETIC_RESULT")) {
		t.Fatal("old tool result became the new current user instruction")
	}
	if req.Tools[0].Name != "Bash" || req.Messages[0].Parts[0].Text != bigText {
		t.Fatal("building isolated compaction changed the original request")
	}
}

// Dedicated compaction must enter the same paged transport while leaving the
// main conversation's clean native checkpoint in place.
func TestCompactionHistoryImportOversizedInputUsesPrivateArchive(t *testing.T) {
	t.Setenv("MAGPIE_CLAUDE_HISTORY_IMPORT", "1")
	_, runs := scWrapper(t)
	rt, b := scRuntime(t)
	scSaveClean(t, b, "inner-main-kept", false)
	body, err := json.Marshal(map[string]any{
		"model": "claude-opus-5-5", "max_tokens": 64, "system": compactSystemTest,
		"tools": []map[string]any{{"name": "Bash", "input_schema": map[string]any{"type": "object"}}},
		"messages": []map[string]any{
			{"role": "user", "content": strings.Repeat("COMPACTION_ARCHIVE αβ\n", 40000)},
			{"role": "assistant", "content": []map[string]any{{"type": "tool_use", "id": "old-summary-call", "name": "Bash", "input": map[string]any{"command": "HISTORICAL_ACTION_ONLY"}}}},
			{"role": "user", "content": []map[string]any{
				{"type": "tool_result", "tool_use_id": "old-summary-call", "content": "HISTORICAL_SUMMARY_RESULT"},
				{"type": "text", "text": "Your task is to create a detailed summary of the conversation so far."},
			}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	code, out := scServe(t, rt, scOuter, string(body))
	if code != 200 || !strings.Contains(out, "SC_ANSWER") {
		t.Fatalf("oversized compaction did not start: %d %.300s", code, out)
	}
	started := onlyRun(t, runs())
	if len(started["stdin"]) >= interactiveHistoricalBootstrapMaxBytes || !strings.Contains(started["stdin"], interactiveArchiveTool) {
		t.Fatal("oversized compaction did not submit a bounded archive-reading prompt")
	}
	if started["resume"] != "" || started["seed.jsonl"] != "" || strings.Contains(started["stdin"], "HISTORICAL_ACTION_ONLY") {
		t.Fatal("paged compaction resumed the main session or exposed old actions as the new task")
	}
	if !strings.Contains(started["stdin"], "Summarize the loaded archival conversation") {
		t.Fatal("compaction lost its current summarization request")
	}
	saved, ok, err := b.loadInteractiveSession(scOwner, scOuter)
	if err != nil || !ok || saved.Dirty || saved.SessionID != "inner-main-kept" {
		t.Fatalf("compaction changed the main checkpoint: ok=%t err=%v", ok, err)
	}
}
