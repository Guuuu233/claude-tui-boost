package bridge

import (
	"errors"
	"log"
	"net/http"
	"strings"
)

type preparedInteractiveRequest struct {
	request          *Request
	readOnlyOptIn    int
	explicitReadOnly bool
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
	return preparedInteractiveRequest{request: req, readOnlyOptIn: optIn}, http.StatusOK, nil
}

// The caller releases the outer turn for a qualified recovery request.
func (b *subscriptionBridge) claimExplicitReadOnlyRecovery(owner, outerSession string, prepared *preparedInteractiveRequest) error {
	if outerSession == "" || prepared.readOnlyOptIn < 0 {
		return nil
	}
	model := prepared.request.Model
	eligible, err := b.explicitReadOnlyRecoveryEligible(owner, outerSession, model)
	if err != nil || !eligible {
		return err
	}
	if !b.claimInteractiveOuterTurn(owner, outerSession) {
		return errors.New("Claude interactive recovery already in flight")
	}
	eligible, err = b.explicitReadOnlyRecoveryEligible(owner, outerSession, model)
	if err != nil || !eligible {
		b.releaseInteractiveOuterTurn(owner, outerSession)
		return err
	}
	prepared.explicitReadOnly = true
	prepared.request = interactiveSanitizeReadOnly(prepared.request)
	return nil
}

func (b *subscriptionBridge) explicitReadOnlyRecoveryEligible(owner, outerSession, model string) (bool, error) {
	saved, ok, err := b.loadInteractiveSession(owner, outerSession)
	return ok && saved.Dirty && (saved.Model == "" || saved.Model == model), err
}

// The caller holds the outer turn while releasing an abandoned parked owner.
func (b *subscriptionBridge) releaseAbandonedRecoveryOwner(owner, outerSession, model string) error {
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
