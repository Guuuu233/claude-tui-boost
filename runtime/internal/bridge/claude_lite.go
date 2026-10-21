package bridge

import (
	"context"
	"errors"
	"log"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"sync/atomic"
	"time"
)

// A client of the Messages API sends its whole conversation with every
// request and runs every tool itself: the native Claude here has no tools of
// its own (--tools ""), only the client's, through MCP. So the request is
// the truth. It continues the live or checkpointed native session where it
// exactly can; otherwise the native session is rebuilt from the request's
// own structured history — tool calls and their results included, so the
// model sees what already ran — instead of being refused or answered by a
// tool-free recovery turn. A rebuild cannot run a tool twice: only the
// client runs tools, and only the calls it is handed.
//
// A conversation's helper calls (titles, subagents, other models) keep
// upstream's routing: they run stateless, beside the conversation's native
// session and checkpoint. So does a request without a conversation id.

// liteTurnWait bounds how long a conversation's turn waits for its previous
// turn to let go of it (a reply still unwinding after its client left, a
// parked run being stopped). A conversation still generating after it is
// answered 503 with Retry-After: a second native run of one conversation,
// able to call tools beside the first, is never started.
var liteTurnWait = 60 * time.Second

// liteContinueText is the turn a rebuilt session is given when the request
// ends in tool results with nothing else to say.
const liteContinueText = "Continue from the tool results above."

// liteResultsReceived closes a rebuilt history that ends in tool results.
// Resuming a session whose last message is the user's, Claude Code answers
// that message itself ("No response requested.") into the new reply.
const liteResultsReceived = "Tool results received."

// statelessSession is the signed bridge session of a request that has no
// conversation of its own (the plugin found no stable conversation id).
const statelessSession = "stateless"

func (rt *runtimeTUI) serveLite(w http.ResponseWriter, r *http.Request, model, outerSession string, body []byte, usage *Usage) (int, string) {
	owner := "claude-tui\x00default"
	req, err := parseAnthropic(body)
	if err != nil {
		return writeError(w, protoAnthropic, http.StatusBadRequest, err.Error()), err.Error()
	}
	req.Model = model
	// Rebuilding is not permission to erase a mismatched tool result. When
	// the caller's visible final assistant turn contains tool_use, every
	// returned ID must match that turn, even if the old native run is gone.
	// Compacted histories without a visible call remain eligible for rebuild.
	if err := liteVisibleToolHandoff(req); err != nil {
		msg := "Claude interactive tool result does not match its visible tool call; refusing"
		return writeError(w, protoAnthropic, http.StatusConflict, msg), msg
	}
	if rt.bridge.liteToolTurnWasDelivered(owner, outerSession, req) {
		msg := "Claude interactive tool results already delivered; refusing duplicate continuation"
		return writeError(w, protoAnthropic, http.StatusConflict, msg), msg
	}
	upstream := func() (int, string) {
		start := func(ctx context.Context, req *Request) (*subscriptionRun, <-chan Event, error) {
			return rt.bridge.startInteractiveRequest(ctx, req, model, "", owner, outerSession)
		}
		return rt.serveMessagesInner(w, r, protoAnthropic, "Claude Code", model, owner, outerSession, body, usage, start)
	}
	// Desktop's own compaction and suggestion calls already run isolated.
	if claudeDesktopCompaction(req) || claudeDesktopSuggestion(req) {
		return upstream()
	}
	// The exact continuation of a live run — its tool results, perhaps with
	// what the user said meanwhile — goes on in that native session.
	if run, results, how := rt.bridge.match(req); run != nil && liteContinues(owner, model, req, run, results, how) {
		return upstream()
	}
	if outerSession != "" {
		if err := rt.bridge.verifyInteractiveSessionStore(); err != nil {
			log.Printf("Claude interactive checkpoint store integrity rejected: %v", err)
			msg := "Claude interactive checkpoint store invalid"
			return writeError(w, protoAnthropic, http.StatusInternalServerError, msg), msg
		}
	}
	if outerSession != "" && !rt.bridge.liteCanonical(owner, outerSession, model, req) {
		outerSession = ""
	}
	if outerSession != "" {
		if !rt.bridge.takeLiteTurn(r.Context(), owner, outerSession) {
			msg := "Claude interactive conversation is still answering another request; retry shortly"
			w.Header().Set("Retry-After", "5")
			return writeError(w, protoAnthropic, http.StatusServiceUnavailable, msg), msg
		}
		defer rt.bridge.releaseInteractiveOuterTurn(owner, outerSession)
	}
	if len(req.Safeguards) > 0 {
		req.SafeguardBeta = "dangerous-tool-use-2026-09-03"
		for _, beta := range strings.Split(r.Header.Get("anthropic-beta"), ",") {
			if beta = strings.TrimSpace(beta); strings.HasPrefix(beta, "dangerous-tool-use-") {
				req.SafeguardBeta = beta
				break
			}
		}
	}
	var search Tool
	if req.WebSearch && !searching(r.Context()) && canSearch() {
		search = searchTool(req.Tools)
		req.Tools = append(slices.Clone(req.Tools), search)
		req.SearchTool = search.Name
	}
	run, events, err := rt.bridge.startLite(r.Context(), req, model, owner, outerSession)
	if err != nil {
		return writeError(w, protoAnthropic, http.StatusBadGateway, "Claude Code: "+err.Error()), err.Error()
	}
	run.mu.Lock()
	keepImage := len(run.images) > 0
	run.tools = map[string]bool{}
	for _, t := range req.Tools {
		run.tools[t.Name] = true
	}
	if keepImage {
		run.tools[interactiveImageTool] = true
	}
	if search.Name != "" && config.SearchHandler != nil {
		run.search, run.searchName = config.SearchHandler, search.Name
	}
	run.mu.Unlock()
	run.heard(req.Messages)
	began := time.Now()
	var letting atomic.Bool
	gone := context.AfterFunc(r.Context(), func() {
		letting.Store(true)
		log.Printf("Claude Code run on %s stopped: the client went away %s into the reply", model, time.Since(began).Round(time.Millisecond))
		run.letGoFor(events)
	})
	defer gone()
	abort := func() {
		if !letting.Load() {
			run.abort()
		}
	}
	return relay(w, r, protoAnthropic, "Claude Code", req, events, usage, abort, func(said, stop string, ok bool) {
		if !gone() {
			return
		}
		run.ended(req, said, stop, ok)
	})
}

func (b *subscriptionBridge) noteLiteCompletedToolTurn(owner, outerSession string, req *Request) {
	if b == nil || outerSession == "" || req == nil || !interactiveToolContinuation(req) {
		return
	}
	key := interactiveSessionStateKey(owner, outerSession)
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.liteCompleted == nil || len(b.liteCompleted) >= 1024 {
		b.liteCompleted = make(map[string]string)
	}
	b.liteCompleted[key] = historyKey(req.Messages)
}

func (b *subscriptionBridge) liteToolTurnWasDelivered(owner, outerSession string, req *Request) bool {
	if b == nil || outerSession == "" || req == nil || !interactiveToolContinuation(req) {
		return false
	}
	key := interactiveSessionStateKey(owner, outerSession)
	b.mu.Lock()
	prior := b.liteCompleted[key]
	b.mu.Unlock()
	return prior != "" && prior == historyKey(req.Messages)
}

func liteVisibleToolHandoff(req *Request) error {
	if req == nil {
		return errors.New("missing request")
	}
	clean, _, err := interactiveRequestWithoutSystem(req)
	if err != nil {
		return err
	}
	end := len(clean.Messages)
	userStart := end
	for userStart > 0 && clean.Messages[userStart-1].Role == "user" {
		userStart--
	}
	if userStart == end {
		return nil
	}
	assistantStart := userStart
	for assistantStart > 0 && clean.Messages[assistantStart-1].Role == "assistant" {
		assistantStart--
	}
	if assistantStart == userStart {
		return nil // compacted result with no visible assistant: cannot verify
	}
	visibleCall, returned := false, false
	for _, m := range clean.Messages[assistantStart:userStart] {
		for _, p := range m.Parts {
			visibleCall = visibleCall || p.Kind == ToolCall
		}
	}
	for _, m := range clean.Messages[userStart:] {
		for _, p := range m.Parts {
			returned = returned || p.Kind == ToolResult
		}
	}
	if visibleCall && returned {
		return validateInteractiveToolContinuation(clean)
	}
	return nil
}

// liteContinues reports whether req exactly continues run: the same owner,
// model, conversation, tools and settings it was started with. Only then is
// it handed to the run; anything else is a new turn.
func liteContinues(owner, model string, req *Request, run *subscriptionRun, results []Part, how string) bool {
	if !interactiveToolContinuation(req) || !run.interactive || run.owner != owner || run.model != model {
		return false
	}
	if !run.offers(req.Tools) && !run.exactInteractiveToolGrowth(owner, req, how) {
		return false
	}
	if validateInteractiveMatchedContinuation(req, run, results, how) != nil || !run.follows(req.Messages) {
		return false
	}
	run.mu.Lock()
	sameContext := run.interactiveContextKey == turnKey(owner, req, nil) && run.effort == req.Effort
	sameSafeguards := interactiveSameSafeguards(run.safeguards, req.Safeguards) &&
		(len(req.Safeguards) == 0 || run.safeguardBeta == req.SafeguardBeta)
	run.mu.Unlock()
	return sameSafeguards && (sameContext || run.interactiveEquivalentContext(req) || run.exactInteractiveToolGrowth(owner, req, how))
}

// liteCanonical is upstream's helper routing: a request on a conversation id
// is that conversation's own turn unless it is a different thread the
// checkpoint does not verify, or a one-message call for another model.
func (b *subscriptionBridge) liteCanonical(owner, outerSession, model string, req *Request) bool {
	shape, _, err := interactiveRequestWithoutSystem(req)
	if err != nil {
		return true
	}
	if active := b.outerThread(owner, outerSession); active != "" && active != firstWords(req) {
		_, _, status := b.restoreInteractiveSession(owner, outerSession, req)
		if status != interactiveRestoreExact && status != interactiveRestoreReplyAnchor && status != interactiveRestoreCompanion {
			return false
		}
	}
	if len(shape.Messages) == 1 {
		saved, savedOK, _ := b.loadInteractiveSession(owner, outerSession)
		if savedOK && ((saved.Model != "" && saved.Model != model) || (saved.Model == "" && claudeTier(model) == "haiku")) {
			return false
		}
	}
	return true
}

// takeLiteTurn makes this request the conversation's only turn. A turn still
// unwinding is waited out. A run parked on tool calls is stopped: this is
// the conversation's own next request (helpers were routed stateless before
// here), so those calls are either answered in its history — and served
// from it — or never reached the client. It reports false when another run
// of the conversation is still generating after liteTurnWait.
func (b *subscriptionBridge) takeLiteTurn(ctx context.Context, owner, outerSession string) bool {
	deadline := time.Now().Add(liteTurnWait)
	for {
		if b.claimInteractiveOuterTurn(owner, outerSession) {
			old := b.interactiveOuterOwner(owner, outerSession)
			if old == nil {
				return true
			}
			old.mu.Lock()
			idle := old.terminalDelivered || !old.parkedAt.IsZero()
			old.mu.Unlock()
			if idle {
				log.Printf("Claude interactive stopped the conversation's idle or parked run for its next request")
				old.abort()
			}
			b.releaseInteractiveOuterTurn(owner, outerSession)
		}
		if time.Now().After(deadline) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// startLite starts the native run for a turn: the checkpointed session
// resumed when the request exactly follows it, a first turn as a first turn,
// and otherwise a session rebuilt from the request's history. Stateless
// requests (outerSession "") never read or write a checkpoint.
func (b *subscriptionBridge) startLite(ctx context.Context, req *Request, model, owner, outerSession string) (*subscriptionRun, <-chan Event, error) {
	shape, _, err := interactiveRequestWithoutSystem(req)
	if err != nil {
		return nil, nil, err
	}
	if outerSession != "" {
		saved, savedOK, err := b.loadInteractiveSession(owner, outerSession)
		if err != nil {
			return nil, nil, err
		}
		if savedOK && !saved.Dirty && (saved.Model == "" || saved.Model == model) {
			if saved, since, status := b.restoreInteractiveSession(owner, outerSession, req); status == interactiveRestoreExact || status == interactiveRestoreReplyAnchor || status == interactiveRestoreCompanion {
				b.anchorOuterThread(owner, outerSession, req)
				contextChanged := saved.ContextKey != "" && saved.ContextKey != turnKey(owner, req, nil)
				return b.startInteractiveResumeTurn(ctx, req, model, "", owner, outerSession, saved, since, contextChanged)
			} else {
				log.Printf("Claude interactive rebuilding native session from the request: checkpoint %s", status)
			}
		} else if savedOK {
			log.Printf("Claude interactive rebuilding native session from the request: checkpoint dirty=%t model_match=%t", saved.Dirty, saved.Model == "" || saved.Model == model)
		}
		b.anchorOuterThread(owner, outerSession, req)
	}
	if len(shape.Messages) == 1 && validateInteractiveFirstTurn(shape) == nil {
		return b.startInteractiveOneTurn(ctx, req, model, "", owner, outerSession)
	}
	seeded, prompt, images, err := liteSeed(req)
	if err != nil {
		return nil, nil, err
	}
	log.Printf("Claude interactive starting a native session rebuilt from the request: history=%d stateless=%t", len(seeded.seedHistory), outerSession == "")
	return b.startInteractiveWithPromptImages(ctx, seeded, model, "", owner, outerSession, prompt, "", images, false)
}

// anchorOuterThread records req's thread as the conversation's own, as
// upstream does once a canonical start is verified.
func (b *subscriptionBridge) anchorOuterThread(owner, outerSession string, req *Request) {
	thread := firstWords(req)
	if thread == "" {
		return
	}
	key := interactiveSessionStateKey(owner, outerSession)
	b.mu.Lock()
	b.outerThreads[key] = thread
	b.mu.Unlock()
}

// liteSeed splits req into the history a rebuilt native session resumes from
// and the turn it is given: the user's messages after the last assistant
// reply. Tool results there stay in the history, where the native session
// sees them answer its calls; tool calls nothing answers (and answers to no
// call) are dropped, as the Messages API refuses them.
func liteSeed(req *Request) (*Request, string, map[string]Part, error) {
	msgs := req.Messages
	k := len(msgs)
	for k > 0 && msgs[k-1].Role != "assistant" {
		k--
	}
	history := slices.Clone(msgs[:k])
	var turn []Message
	for _, m := range msgs[k:] {
		var results, rest []Part
		for _, p := range m.Parts {
			if p.Kind == ToolResult {
				results = append(results, p)
			} else {
				rest = append(rest, p)
			}
		}
		if len(results) > 0 {
			history = append(history, Message{Role: "user", Parts: results})
		}
		if len(rest) > 0 {
			turn = append(turn, Message{Role: m.Role, Parts: rest})
		}
	}
	history = pairedToolTraffic(history)
	if n := len(history); n > 0 && history[n-1].Role != "assistant" {
		history = append(history, Message{Role: "assistant", Parts: []Part{{Kind: Text, Text: liteResultsReceived}}})
	}
	if !hasUserText(turn) {
		turn = append(turn, Message{Role: "user", Parts: []Part{{Kind: Text, Text: liteContinueText}}})
	}
	turnReq := *req
	turnReq.Messages = turn
	prompt, images, err := renderInteractiveFirstPromptWithImages(&turnReq)
	if err != nil {
		return nil, "", nil, err
	}
	seeded := *req
	seeded.seedHistory = history
	return &seeded, prompt, images, nil
}

func hasUserText(msgs []Message) bool {
	for _, m := range msgs {
		if m.Role != "user" {
			continue
		}
		for _, p := range m.Parts {
			if (p.Kind == Text && p.Text != "") || p.Kind == Image || p.Kind == File {
				return true
			}
		}
	}
	return false
}

// pairedToolTraffic keeps only tool calls answered in the next user message
// and tool results answering a call of the assistant message before them.
func pairedToolTraffic(msgs []Message) []Message {
	out := make([]Message, 0, len(msgs))
	for i, m := range msgs {
		var keep []Part
		for _, p := range m.Parts {
			switch {
			case p.Kind == ToolCall && m.Role == "assistant":
				if i+1 < len(msgs) && answers(msgs[i+1], p.ID) {
					keep = append(keep, p)
				}
			case p.Kind == ToolResult:
				if i > 0 && calls(msgs[i-1], p.CallID) {
					keep = append(keep, p)
				}
			default:
				keep = append(keep, p)
			}
		}
		if len(keep) > 0 {
			out = append(out, Message{Role: m.Role, Parts: keep})
		}
	}
	return out
}

func answers(m Message, id string) bool {
	if m.Role != "user" {
		return false
	}
	for _, p := range m.Parts {
		if p.Kind == ToolResult && p.CallID == id {
			return true
		}
	}
	return false
}

func calls(m Message, id string) bool {
	if m.Role != "assistant" {
		return false
	}
	for _, p := range m.Parts {
		if p.Kind == ToolCall && p.ID == id {
			return true
		}
	}
	return false
}

var limitWords = regexp.MustCompile(`(?i)hit your .*limit|(session|usage|weekly|5-hour) limit|limit.{0,24}resets|rate.?limit|too many requests`)

// liteStatus is the status a failed turn is answered with. A native error
// that only carries the generic 502 but says the account hit its usage or
// rate limit is a 429: clients then wait instead of retrying at once.
func liteStatus(status int, msg string) int {
	if (status == 0 || status == http.StatusBadGateway) && limitWords.MatchString(msg) {
		return http.StatusTooManyRequests
	}
	return status
}
