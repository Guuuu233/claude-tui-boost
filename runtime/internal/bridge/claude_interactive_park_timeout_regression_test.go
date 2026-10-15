package bridge

import (
	"testing"
	"time"
)

func TestInteractiveNativeToolWaitDoesNotExpireAfterFiveMinutes(t *testing.T) {
	// In the native TUI path stdin is deliberately nil. Before the fix,
	// park() treated that as a disposable one-shot run and reset the PTY
	// abort timer to parkLongest (five minutes) despite live MCP tools.
	native := &subscriptionRun{interactive: true, asked: []string{"Bash", "Write"}}
	if wait := native.parkedToolWaitTimeout(); wait < 60*time.Minute {
		t.Fatalf("native PTY callback would expire during long external tool execution: %s", wait)
	}
	if interactiveActiveLongest < 6*time.Hour {
		t.Fatalf("native active-run watchdog too short: %s", interactiveActiveLongest)
	}
	// The short path remains intact for disposable -p executions.
	oneShot := &subscriptionRun{interactive: false}
	if wait := oneShot.parkedToolWaitTimeout(); wait != parkLongest {
		t.Fatalf("one-shot tool timeout unexpectedly changed: %s", wait)
	}
	if native.stdin != nil {
		t.Fatal("regression fixture must model actual interactive nil stdin")
	}
}
