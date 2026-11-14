package bridge

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A fast native MCP request can arrive after the run is published but
// before the transcript reader has registered its onCall listener. The
// request must still become visible to the client without a JSONL row.
func TestInteractiveCallbackBeforeReaderStarts(t *testing.T) {
	b := newSubscriptionBridge()
	defer bridges.Delete(b)
	run := &subscriptionRun{bridge: b, token: "fast-native", interactive: true, model: "claude-opus-5-5", tools: map[string]bool{"Read": true}, pending: map[string]chan mcpToolResult{}, timer: time.AfterFunc(time.Minute, func() {})}
	defer run.timer.Stop()
	events := run.attach()
	b.mu.Lock()
	b.runs[run.token] = run
	b.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest("POST", "/_magpie/claude-mcp/fast-native", strings.NewReader(`{"tool_call_id":"fast-tool","name":"Read","arguments":{}}`)).WithContext(ctx)
	req.SetPathValue("token", run.token)
	complete := make(chan struct{})
	go func() { b.mcpCall(httptest.NewRecorder(), req); close(complete) }()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		run.mu.Lock()
		ok := run.pending["fast-tool"] != nil
		run.mu.Unlock()
		if ok {
			break
		}
		time.Sleep(time.Millisecond)
	}
	rd, wr := io.Pipe()
	defer rd.Close()
	defer wr.Close()
	go run.readInteractiveOneTurn(rd)
	seen := false
	timeout := time.After(2300 * time.Millisecond)
loop:
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				break loop
			}
			if ev.Kind == KToolStart && ev.ID == "fast-tool" {
				seen = true
			}
		case <-timeout:
			break loop
		}
	}
	if !seen {
		t.Fatal("MCP request arrived before transcript reader but never reached client")
	}
	cancel()
	run.abort()
	select {
	case <-complete:
	case <-time.After(time.Second):
		t.Fatal("callback never stopped")
	}
}

// A duplicate stdio MCP notification for one native tool_use ID must not
// overwrite its waiter and strand the first callback until Desktop times out.
func TestInteractiveDuplicateMCPCallbackRejected(t *testing.T) {
	b := newSubscriptionBridge()
	defer bridges.Delete(b)
	run := &subscriptionRun{bridge: b, token: "duplicate-callback", interactive: true, model: "claude-opus-5-5", tools: map[string]bool{"Read": true}, pending: map[string]chan mcpToolResult{}, timer: time.AfterFunc(time.Minute, func() {})}
	defer run.timer.Stop()
	b.mu.Lock()
	b.runs[run.token] = run
	b.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	makeReq := func() *httptest.ResponseRecorder { return httptest.NewRecorder() }
	first := makeReq()
	second := makeReq()
	request := func() *http.Request {
		req := httptest.NewRequest("POST", "/_magpie/claude-mcp/duplicate-callback", strings.NewReader(`{"tool_call_id":"same-id","name":"Read","arguments":{}}`)).WithContext(ctx)
		req.SetPathValue("token", run.token)
		return req
	}
	doneFirst := make(chan struct{})
	go func() { b.mcpCall(first, request()); close(doneFirst) }()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		run.mu.Lock()
		present := run.pending["same-id"] != nil
		run.mu.Unlock()
		if present {
			break
		}
		time.Sleep(time.Millisecond)
	}
	doneSecond := make(chan struct{})
	go func() { b.mcpCall(second, request()); close(doneSecond) }()
	select {
	case <-doneSecond:
		if second.Code != 409 {
			t.Fatalf("duplicate callback got %d, expected 409", second.Code)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("duplicate callback left a second waiter blocked")
	}
	cancel()
	run.abort()
	select {
	case <-doneFirst:
	case <-time.After(time.Second):
		t.Fatal("original callback remained stuck")
	}
}

// A tool that arrives after the prior tool segment has settled cannot be
// shown on that already-closed HTTP reply. It must return a bounded error
// to Claude, rather than leaving its stdio MCP call blocked for 13 minutes.
func TestInteractiveLateParallelCallbackFailsFastWithoutExecution(t *testing.T) {
	b := newSubscriptionBridge()
	defer bridges.Delete(b)
	run := &subscriptionRun{bridge: b, token: "late-parallel", interactive: true, model: "claude-opus-5-5", tools: map[string]bool{"Read": true}, pending: map[string]chan mcpToolResult{}, timer: time.AfterFunc(time.Minute, func() {})}
	defer run.timer.Stop()
	first := run.attach()
	b.mu.Lock()
	b.runs[run.token] = run
	b.mu.Unlock()
	rd, wr := io.Pipe()
	defer rd.Close()
	defer wr.Close()
	done := make(chan struct{})
	go func() { run.readInteractiveOneTurn(rd); close(done) }()
	until := time.Now().Add(time.Second)
	for time.Now().Before(until) {
		run.mu.Lock()
		ready := run.onCall != nil
		run.mu.Unlock()
		if ready {
			break
		}
		time.Sleep(time.Millisecond)
	}
	// First call is visible from the native transcript and settles normally.
	_, _ = io.WriteString(wr, `{"type":"assistant","uuid":"tool-a","message":{"id":"msg-a","model":"claude-opus-5-5","content":[{"type":"tool_use","id":"first","name":"mcp__magpie__Read","input":{}}]}}`+"\n")
	for range first {
	}
	run.mu.Lock()
	hadSegment := run.segment != nil
	run.mu.Unlock()
	if hadSegment {
		t.Fatal("first segment not closed before late callback")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest("POST", "/_magpie/claude-mcp/late-parallel", strings.NewReader(`{"tool_call_id":"second","name":"Read","arguments":{}}`)).WithContext(ctx)
	req.SetPathValue("token", run.token)
	response := httptest.NewRecorder()
	completed := make(chan struct{})
	go func() { b.mcpCall(response, req); close(completed) }()
	select {
	case <-completed:
		if response.Code != 200 || !strings.Contains(response.Body.String(), `"is_error":true`) {
			t.Fatalf("undeliverable callback should return MCP tool error without running user tool: HTTP=%d", response.Code)
		}
	case <-time.After(2200 * time.Millisecond):
		t.Fatal("second parallel callback blocked after first tool handoff closed")
	}
	_ = wr.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("reader leaked")
	}
	run.abort()
}

// If Claude abandons a native MCP request while the reader is still
// initializing, the stale buffered callback must never execute a tool.
func TestInteractiveCancelledEarlyCallbackNeverExecutes(t *testing.T) {
	b := newSubscriptionBridge()
	defer bridges.Delete(b)
	run := &subscriptionRun{bridge: b, token: "cancel-early", interactive: true, model: "claude-opus-5-5", tools: map[string]bool{"Write": true}, pending: map[string]chan mcpToolResult{}, timer: time.AfterFunc(time.Minute, func() {})}
	defer run.timer.Stop()
	events := run.attach()
	b.mu.Lock()
	b.runs[run.token] = run
	b.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest("POST", "/_magpie/claude-mcp/cancel-early", strings.NewReader(`{"tool_call_id":"cancel-tool","name":"Write","arguments":{}}`)).WithContext(ctx)
	req.SetPathValue("token", run.token)
	done := make(chan struct{})
	go func() { b.mcpCall(httptest.NewRecorder(), req); close(done) }()
	until := time.Now().Add(time.Second)
	for time.Now().Before(until) {
		run.mu.Lock()
		present := run.pending["cancel-tool"] != nil
		run.mu.Unlock()
		if present {
			break
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancelled MCP callback did not exit")
	}
	rd, wr := io.Pipe()
	defer rd.Close()
	defer wr.Close()
	readerDone := make(chan struct{})
	go func() { run.readInteractiveOneTurn(rd); close(readerDone) }()
	select {
	case ev := <-events:
		if ev.Kind == KToolStart {
			t.Fatal("client was told to execute a cancelled tool")
		}
	case <-time.After(1600 * time.Millisecond):
	}
	run.mu.Lock()
	pending := len(run.pending)
	run.mu.Unlock()
	if pending != 0 {
		t.Fatal("cancelled native callback waiter leaked")
	}
	_ = wr.Close()
	select {
	case <-readerDone:
	case <-time.After(time.Second):
		t.Fatal("reader leaked")
	}
	run.abort()
}

// Private archive reads return locally, retain their tools across an outer
// tool handoff, and disappear with the run that owns the source bytes.
func TestInteractiveArchiveCallbackStaysPrivateThroughHandoffAndCleanup(t *testing.T) {
	b := newSubscriptionBridge()
	defer bridges.Delete(b)
	run := &subscriptionRun{bridge: b, token: "archive-local", tmp: t.TempDir(), interactive: true,
		historyArchive: newClaudeHistoryArchive("PRIVATE_CALLBACK_SOURCE"),
		images:         map[string]Part{"synthetic-image": {Kind: Image, MediaType: "image/png", Data: "QUJD"}},
		pending:        map[string]chan mcpToolResult{}, tools: map[string]bool{}}
	events := run.attach()
	defer run.finish()
	b.mu.Lock()
	b.runs[run.token] = run
	b.mu.Unlock()
	request := &Request{Tools: []Tool{{Name: "Read", Schema: json.RawMessage(`{"type":"object"}`)}}}
	run.mu.Lock()
	run.resetAllowedToolsLocked(request)
	run.mu.Unlock()
	call := func() *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]any{"tool_call_id": "private-page", "name": interactiveArchiveTool, "arguments": map[string]int{"page": 0}})
		req := httptest.NewRequest("POST", "/_magpie/claude-mcp/archive-local", strings.NewReader(string(body)))
		req.SetPathValue("token", run.token)
		rec := httptest.NewRecorder()
		b.mcpCall(rec, req)
		return rec
	}
	rec := call()
	var reply mcpToolResult
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &reply) != nil || reply.IsError || len(reply.Content) != 1 {
		t.Fatal("private archive callback failed")
	}
	text, _ := reply.Content[0]["text"].(string)
	_, chunk, ok := strings.Cut(text, "\n")
	if !ok || chunk != "PRIVATE_CALLBACK_SOURCE" {
		t.Fatal("private callback changed the archive bytes")
	}
	run.mu.Lock()
	pending, queued, asked := len(run.pending), len(run.queuedCallbacks), len(run.asked)
	run.mu.Unlock()
	b.mu.Lock()
	clientCalls := len(b.calls)
	b.mu.Unlock()
	if pending != 0 || queued != 0 || asked != 0 || clientCalls != 0 {
		t.Fatal("private page read entered the outer tool dispatch path")
	}
	select {
	case event := <-events:
		t.Fatalf("private callback emitted an outer event: %v", event.Kind)
	default:
	}
	request.Tools = append(request.Tools, Tool{Name: "Added", Schema: json.RawMessage(`{"type":"object"}`)}, Tool{Name: interactiveArchiveTool})
	run.mu.Lock()
	tools := run.interactiveToolsLocked(request)
	run.resetAllowedToolsLocked(request)
	offeredArchive, offeredImage, offeredAdded := run.tools[interactiveArchiveTool], run.tools[interactiveImageTool], run.tools["Added"]
	waiter := make(chan mcpToolResult, 1)
	run.pending["external-call"] = waiter
	run.mu.Unlock()
	if !offeredArchive || !offeredImage || !offeredAdded {
		t.Fatal("refreshed allowlist lost a private reader or a newly offered client tool")
	}
	if _, err := run.continueWith([]Part{{Kind: ToolResult, CallID: "external-call", Text: "EXTERNAL_RESULT"}}, tools); err != nil {
		t.Fatal(err)
	}
	continued := <-waiter
	archiveTools, imageTools := 0, 0
	for _, tool := range continued.Tools {
		if tool.Name == interactiveArchiveTool {
			archiveTools++
			if !json.Valid(tool.InputSchema) {
				t.Fatal("external tool name shadowed the private archive schema")
			}
		}
		if tool.Name == interactiveImageTool {
			imageTools++
		}
	}
	if archiveTools != 1 || imageTools != 1 {
		t.Fatal("tool handoff replaced or duplicated the private readers")
	}
	rec = call()
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &reply) != nil || reply.IsError {
		t.Fatal("archive became unavailable after an external tool handoff")
	}
	run.finish()
	run.mu.Lock()
	retained := run.historyArchive != nil
	run.mu.Unlock()
	if retained || call().Code != http.StatusNotFound {
		t.Fatal("finished run retained an addressable private archive")
	}
}

func TestInteractiveArchiveToolRowsStayInsideNativeRun(t *testing.T) {
	run := &subscriptionRun{interactive: true, model: "claude-opus-5-5", tools: map[string]bool{interactiveArchiveTool: true}, pending: map[string]chan mcpToolResult{}}
	events := run.attach()
	defer run.finish()
	rows := `{"type":"assistant","uuid":"archive-row","message":{"id":"archive-message","model":"claude-opus-5-5","content":[{"type":"tool_use","id":"private-read","name":"mcp__magpie__` + interactiveArchiveTool + `","input":{"page":0}}]}}` + "\n" +
		`{"type":"assistant","uuid":"archive-answer","message":{"id":"final-message","model":"claude-opus-5-5","content":[{"type":"text","text":"ARCHIVE_READ_DONE"}]}}` + "\n" +
		`{"type":"result","stop_reason":"end_turn"}` + "\n"
	run.readInteractiveOneTurn(strings.NewReader(rows))
	var answer strings.Builder
	for event := range events {
		if event.Kind == KToolStart || event.Kind == KToolArgs || event.Kind == KError {
			t.Fatalf("private archive row escaped into the outer stream: %v", event.Kind)
		}
		if event.Kind == KText {
			answer.WriteString(event.Text)
		}
	}
	if answer.String() != "ARCHIVE_READ_DONE" || len(run.asked) != 0 {
		t.Fatal("private read changed the final answer or outer tool accounting")
	}
}

func TestInteractiveArchiveReaderHonorsReadOnlyRecovery(t *testing.T) {
	b := newSubscriptionBridge()
	defer bridges.Delete(b)
	run := &subscriptionRun{bridge: b, token: "archive-readonly", tmp: t.TempDir(), interactive: true, readOnlyRecovery: true,
		historyArchive: newClaudeHistoryArchive("READONLY_PRIVATE_SOURCE"), pending: map[string]chan mcpToolResult{}}
	defer run.finish()
	b.mu.Lock()
	b.runs[run.token] = run
	b.mu.Unlock()
	body, _ := json.Marshal(map[string]any{"tool_call_id": "readonly-page", "name": interactiveArchiveTool, "arguments": map[string]int{"page": 0}})
	req := httptest.NewRequest("POST", "/_magpie/claude-mcp/archive-readonly", strings.NewReader(string(body)))
	req.SetPathValue("token", run.token)
	rec := httptest.NewRecorder()
	b.mcpCall(rec, req)
	var reply mcpToolResult
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &reply) != nil || !reply.IsError || strings.Contains(rec.Body.String(), "READONLY_PRIVATE_SOURCE") {
		t.Fatal("private reader bypassed the tool-free recovery boundary")
	}
}

// A resumed native session may still mention the previous run's private tool.
// Its new run has no old archive: stale reads fail locally and a client tool
// with the private name never becomes an alternative source of execution.
func TestInteractiveArchiveStaleReadsAndNameCollisionsStayPrivate(t *testing.T) {
	for _, tc := range []struct {
		name    string
		archive bool
		closed  bool
		expired bool
	}{
		{name: "active-run-with-archive", archive: true},
		{name: "new-run-without-old-archive"},
		{name: "closed-run-still-registered", archive: true, closed: true},
		{name: "expired-run-token", archive: true, expired: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := newSubscriptionBridge()
			run := &subscriptionRun{bridge: b, token: "archive-boundary", tmp: t.TempDir(), interactive: true,
				pending: map[string]chan mcpToolResult{}, tools: map[string]bool{}}
			defer func() { b.removeRun(run); bridges.Delete(b) }()
			if tc.archive {
				run.historyArchive = newClaudeHistoryArchive("RUN_LOCAL_PRIVATE_ARCHIVE")
			}
			events := run.attach()
			b.mu.Lock()
			b.runs[run.token] = run
			b.mu.Unlock()
			request := &Request{Tools: []Tool{
				{Name: "Read", Schema: json.RawMessage(`{"type":"object"}`)},
				{Name: interactiveArchiveTool, Description: "EXTERNAL_COLLISION", Schema: json.RawMessage(`{"type":"object","properties":{"external":{"type":"string"}}}`)},
			}}
			for refresh := 0; refresh < 2; refresh++ {
				run.mu.Lock()
				tools := run.interactiveToolsLocked(request)
				run.resetAllowedToolsLocked(request)
				offered := run.tools[interactiveArchiveTool]
				run.mu.Unlock()
				readers, ordinary := 0, false
				for _, tool := range tools {
					if tool.Name == "Read" {
						ordinary = true
					}
					if tool.Name == interactiveArchiveTool {
						readers++
						var schema struct {
							Properties map[string]json.RawMessage `json:"properties"`
						}
						if json.Unmarshal(tool.InputSchema, &schema) != nil || schema.Properties["page"] == nil || schema.Properties["external"] != nil || tool.Description == "EXTERNAL_COLLISION" {
							t.Fatal("external same-name tool replaced the private reader")
						}
					}
				}
				wantReaders := 0
				if tc.archive {
					wantReaders = 1
				}
				if readers != wantReaders || offered != tc.archive || !ordinary {
					t.Fatal("refreshed tools changed the archive boundary or ordinary client tools")
				}
				request.Tools = append(request.Tools[:1], Tool{Name: interactiveArchiveTool, Schema: json.RawMessage(`{"type":"string"}`)})
			}
			if tc.closed {
				run.mu.Lock()
				run.closed = true
				run.mu.Unlock()
			}
			if tc.expired {
				b.removeRun(run)
			}
			body, _ := json.Marshal(map[string]any{"tool_call_id": "stale-page", "name": interactiveArchiveTool, "arguments": map[string]int{"page": 0}})
			req := httptest.NewRequest("POST", "/_magpie/claude-mcp/archive-boundary", strings.NewReader(string(body)))
			req.SetPathValue("token", run.token)
			rec := httptest.NewRecorder()
			b.mcpCall(rec, req)
			if tc.expired {
				if rec.Code != http.StatusNotFound {
					t.Fatal("expired run token still addressed a private archive")
				}
			} else {
				var result mcpToolResult
				if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &result) != nil {
					t.Fatal("private archive boundary returned an invalid MCP response")
				}
				available := tc.archive && !tc.closed
				if result.IsError == available {
					t.Fatal("private archive availability crossed the native run lifetime")
				}
				if available {
					if !strings.Contains(rec.Body.String(), "RUN_LOCAL_PRIVATE_ARCHIVE") {
						t.Fatal("active archive reader lost its own source")
					}
				} else if !strings.Contains(rec.Body.String(), "unavailable") || strings.Contains(rec.Body.String(), "RUN_LOCAL_PRIVATE_ARCHIVE") {
					t.Fatal("stale private read exposed source bytes or lost its unavailable error")
				}
			}
			b.mu.Lock()
			clientCalls := len(b.calls)
			b.mu.Unlock()
			run.mu.Lock()
			pending, queued, asked := len(run.pending), len(run.queuedCallbacks), len(run.asked)
			run.mu.Unlock()
			if clientCalls != 0 || pending != 0 || queued != 0 || asked != 0 {
				t.Fatal("stale private read or same-name client tool entered outer dispatch")
			}
			select {
			case event, open := <-events:
				if open {
					t.Fatalf("private archive boundary emitted an outer event: %v", event.Kind)
				}
			default:
			}
		})
	}
}
