package bridge

import (
	"context"
	"log"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"sync/atomic"
	"time"
)

// Claude Science sends its whole conversation with every request and runs
// every tool itself: the native Claude here has no tools of its own
// (--tools ""), only Science's, through MCP. So for a Science conversation
// the request is the truth. It continues the live or checkpointed native
// session where it exactly can; otherwise the native session is rebuilt
// from the history Science sent, never refused. A rebuild cannot run a tool
// twice: only Science runs tools, and only the calls it is handed.
//
// Science's helper calls (memory, sniff, compaction folds, keepalive pings)
// share its conversation id; its integration labels them
// science-<frame>-fork / -aux-<lane>, and they run stateless, beside the
// conversation's native session and checkpoint, never inside them.
var scienceOuterRE = regexp.MustCompile(`^science-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-(aux|fork)(-[a-z0-9_]{1,32})?)?$`)

// scienceOuter reports whether outerSession is a Science label, and whether
// it is a stateless helper call rather than the frame's own conversation.
func scienceOuter(outerSession string) (science, helper bool) {
	m := scienceOuterRE.FindStringSubmatch(outerSession)
	if m == nil {
		return false, false
	}
	return true, m[1] != ""
}

// scienceTurnWait bounds how long a request waits for the conversation's
// previous turn to let go of it (a reply still unwinding after its client
// left, a parked run being stopped) before it is told to retry.
var scienceTurnWait = 60 * time.Second

// scienceContinueText is the turn a rebuilt session is given when Science's
// request ends in tool results with nothing else to say.
const scienceContinueText = "Continue from the tool results above."

// scienceResultsReceived closes a rebuilt history that ends in tool results.
// Resuming a session whose last message is the user's, Claude Code answers
// that message itself ("No response requested.") into the new reply.
const scienceResultsReceived = "Tool results received."

func (rt *runtimeTUI) serveScience(w http.ResponseWriter, r *http.Request, model, outerSession string, helper bool, body []byte, usage *Usage) (int, string) {
	owner := "claude-tui\x00default"
	if helper {
		outerSession = ""
	}
	req, err := parseAnthropic(body)
	if err != nil {
		return writeError(w, protoAnthropic, http.StatusBadRequest, err.Error()), err.Error()
	}
	req.Model = model
	start := func(ctx context.Context, req *Request) (*subscriptionRun, <-chan Event, error) {
		return rt.bridge.startScience(ctx, req, model, owner, outerSession)
	}
	// The exact continuation of a live run — its tool results, perhaps with
	// what the user said meanwhile — goes on in that native session, as any
	// client's does.
	if run, results, how := rt.bridge.match(req); run != nil && scienceContinues(owner, model, req, run, results, how) {
		return rt.serveMessagesInner(w, r, protoAnthropic, "Claude Code", model, owner, outerSession, body, usage, start)
	}
	if outerSession != "" {
		if err := rt.bridge.verifyInteractiveSessionStore(); err != nil {
			log.Printf("Claude interactive checkpoint store integrity rejected: %v", err)
			msg := "Claude interactive checkpoint store invalid"
			return writeError(w, protoAnthropic, http.StatusInternalServerError, msg), msg
		}
		if !rt.bridge.takeScienceTurn(r.Context(), owner, outerSession) {
			msg := "Claude Science conversation is still busy with another request; retry shortly"
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
	run, events, err := start(r.Context(), req)
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
		log.Printf("Claude Science run on %s stopped: the client went away %s into the reply", model, time.Since(began).Round(time.Millisecond))
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

// scienceContinues reports whether req exactly continues run: the same
// owner, model, conversation, tools and settings it was started with. Only
// then is it handed to the run; anything else is a new turn.
func scienceContinues(owner, model string, req *Request, run *subscriptionRun, results []Part, how string) bool {
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

// takeScienceTurn makes this request the conversation's only turn. A turn
// still unwinding is waited out; a run parked on tool calls this request
// does not answer is stopped, since Science has moved on without it.
func (b *subscriptionBridge) takeScienceTurn(ctx context.Context, owner, outerSession string) bool {
	deadline := time.Now().Add(scienceTurnWait)
	wait := func() bool {
		if time.Now().After(deadline) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(100 * time.Millisecond):
			return true
		}
	}
	for !b.claimInteractiveOuterTurn(owner, outerSession) {
		if !wait() {
			return false
		}
	}
	for {
		old := b.interactiveOuterOwner(owner, outerSession)
		if old == nil {
			return true
		}
		old.mu.Lock()
		parked := !old.parkedAt.IsZero() || old.terminalDelivered
		old.mu.Unlock()
		if parked {
			old.abort()
		}
		if !wait() {
			b.releaseInteractiveOuterTurn(owner, outerSession)
			return false
		}
	}
}

// startScience starts the native run for a Science turn: the checkpointed
// session resumed when the request exactly follows it, a first turn as a
// first turn, and otherwise a session rebuilt from the request's history.
func (b *subscriptionBridge) startScience(ctx context.Context, req *Request, model, owner, outerSession string) (*subscriptionRun, <-chan Event, error) {
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
				contextChanged := saved.ContextKey != "" && saved.ContextKey != turnKey(owner, req, nil)
				return b.startInteractiveResumeTurn(ctx, req, model, "", owner, outerSession, saved, since, contextChanged)
			} else {
				log.Printf("Claude Science rebuilding native session from the request: checkpoint %s", status)
			}
		} else if savedOK {
			log.Printf("Claude Science rebuilding native session from the request: checkpoint dirty=%t model_match=%t", saved.Dirty, saved.Model == "" || saved.Model == model)
		}
	}
	if len(shape.Messages) == 1 && validateInteractiveFirstTurn(shape) == nil {
		return b.startInteractiveOneTurn(ctx, req, model, "", owner, outerSession)
	}
	seeded, prompt, images, err := scienceSeed(req)
	if err != nil {
		return nil, nil, err
	}
	return b.startInteractiveWithPromptImages(ctx, seeded, model, "", owner, outerSession, prompt, "", images, false)
}

// scienceSeed splits req into the history a rebuilt native session resumes
// from and the turn it is given: the user's messages after the last
// assistant reply. Tool results there stay in the history, where the
// native session sees them answer its calls; tool calls nothing answers
// (and answers to no call) are dropped, as the Messages API refuses them.
func scienceSeed(req *Request) (*Request, string, map[string]Part, error) {
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
		history = append(history, Message{Role: "assistant", Parts: []Part{{Kind: Text, Text: scienceResultsReceived}}})
	}
	if !hasUserText(turn) {
		turn = append(turn, Message{Role: "user", Parts: []Part{{Kind: Text, Text: scienceContinueText}}})
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
