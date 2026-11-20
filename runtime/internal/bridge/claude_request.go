package bridge

import (
	"errors"
	"log"
	"net/http"
	"strings"
)

type preparedInteractiveRequest struct {
	request       *Request
	readOnlyOptIn int
}

func prepareInteractiveRequest(body []byte, headers http.Header, model string) (preparedInteractiveRequest, int, error) {
	req, err := parseAnthropic(body)
	if err != nil {
		return preparedInteractiveRequest{}, http.StatusBadRequest, err
	}
	req.Model = model
	if err := validateInteractiveOutboundCredentials(body, headers); err != nil {
		return preparedInteractiveRequest{}, http.StatusBadRequest, err
	}
	if claudeDesktopCompaction(req) {
		req = claudeDesktopCompactionRequest(req)
	}
	if err := validateInteractiveRequest(req); err != nil {
		return preparedInteractiveRequest{}, http.StatusConflict, err
	}
	if len(req.Safeguards) > 0 {
		req.SafeguardBeta = "dangerous-tool-use-2026-09-03"
		for _, beta := range strings.Split(headers.Get("anthropic-beta"), ",") {
			if beta = strings.TrimSpace(beta); strings.HasPrefix(beta, "dangerous-tool-use-") {
				req.SafeguardBeta = beta
				break
			}
		}
	}
	optIn := interactiveReadOnlyOptInIndex(req)
	if optIn >= 0 {
		req = interactiveSanitizeReadOnly(req)
	}
	return preparedInteractiveRequest{request: req, readOnlyOptIn: optIn}, http.StatusOK, nil
}

// The caller holds the outer turn while checking the checkpoint and releasing a parked owner.
func (b *subscriptionBridge) prepareExplicitReadOnlyRecovery(owner, outerSession string, req *Request) error {
	saved, ok, err := b.loadInteractiveSession(owner, outerSession)
	if err != nil {
		return err
	}
	model := req.Model
	if !ok || !saved.Dirty || (saved.Model != "" && saved.Model != model) {
		return errors.New("Claude interactive read-only recovery requires a matching dirty checkpoint")
	}
	if saved.Model == "" && claudeTier(model) == "haiku" {
		shape, _, err := interactiveRequestWithoutSystem(req)
		if err != nil {
			return err
		}
		if len(shape.Messages) == 1 {
			return errors.New("Claude interactive read-only recovery requires a model-bound checkpoint for a single-turn Haiku request")
		}
	}
	old := b.interactiveOuterOwner(owner, outerSession)
	if old == nil {
		return nil
	}
	old.mu.Lock()
	parked := old.interactive && old.abandonedByClient && !old.closed && !old.resuming && old.segment == nil &&
		old.owner == owner && old.model == model && !old.parkedAt.IsZero() &&
		len(old.pending) == 0 && len(old.early) == 0 && len(old.late) == 0
	old.mu.Unlock()
	if !parked {
		return errors.New("Claude interactive recovery refused: original tool callbacks are still active")
	}
	log.Print("Claude interactive explicit read-only recovery replacing an abandoned parked PTY")
	old.abort()
	return nil
}
