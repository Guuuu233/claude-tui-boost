package bridge

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInteractiveNativeAutoCompactionEnabled(t *testing.T) {
	fakeClaude(t)
	script := `#!/bin/sh
printf '%s\n' "${DISABLE_AUTO_COMPACT-unset}" > "$COMPACTION_ENV_CAPTURE"
printf '%s\n' '{"type":"system","subtype":"init","session_id":"compact-test"}' '{"type":"assistant","message":{"id":"m1","model":"claude-opus-5-5","content":[{"type":"text","text":"OK"}],"stop_reason":"end_turn"}}' '{"type":"result","subtype":"success","session_id":"compact-test","result":"OK"}'`
	wrapper := filepath.Join(t.TempDir(), "wrapper")
	if err := os.WriteFile(wrapper, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv(interactiveBridgeEnv, wrapper)
	path := filepath.Join(t.TempDir(), "env")
	t.Setenv("COMPACTION_ENV_CAPTURE", path)
	t.Setenv("DISABLE_AUTO_COMPACT", "1")
	b := newSubscriptionBridge()
	defer bridges.Delete(b)
	req := &Request{Model: "claude-opus-5-5", Messages: []Message{{Role: "user", Parts: []Part{{Kind: Text, Text: "hello"}}}}}
	run, events, err := b.startInteractiveOneTurn(context.Background(), req, req.Model, "", "owner", "")
	if err != nil {
		t.Fatal(err)
	}
	defer run.abort()
	for range events {
	}
	value, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(value)) != "unset" {
		t.Fatalf("native auto-compaction disabled: %q", value)
	}
}
