package bridge

import "testing"

// A late-finishing run must not remove the replacement that already owns the
// same outer conversation. Deleting that slot makes a third request believe
// no live run exists while the replacement is still active.
func TestRemoveRunKeepsReplacementLiveOuter(t *testing.T) {
	b := newSubscriptionBridge()
	defer bridges.Delete(b)
	old := &subscriptionRun{bridge: b, token: "old", owner: "owner", outerSession: "outer"}
	replacement := &subscriptionRun{bridge: b, token: "replacement", owner: "owner", outerSession: "outer"}
	key := interactiveSessionStateKey(old.owner, old.outerSession)
	b.runs[old.token] = old
	b.runs[replacement.token] = replacement
	b.liveOuter[key] = replacement

	b.removeRun(old)

	b.mu.Lock()
	live := b.liveOuter[key]
	_, oldRegistered := b.runs[old.token]
	b.mu.Unlock()
	if oldRegistered {
		t.Fatal("the finished old run remains registered")
	}
	if live != replacement {
		t.Fatalf("removing the old run deleted the replacement's liveOuter ownership: got %p want %p", live, replacement)
	}

	b.removeRun(replacement)
	b.mu.Lock()
	live = b.liveOuter[key]
	b.mu.Unlock()
	if live != nil {
		t.Fatal("removing the current owner did not release liveOuter")
	}
}
