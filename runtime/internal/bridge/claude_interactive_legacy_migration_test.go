//go:build darwin || linux

package bridge

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func legacyMigrationFixture(t *testing.T) (*subscriptionBridge, *runtimeTUI, string, string, []byte, string) {
	t.Helper()
	dir := arDir(t)
	t.Setenv("MAGPIE_CLAUDE_DURABLE_TOOL_JOURNAL", "0") // no global change to other sessions
	t.Setenv("MAGPIE_CLAUDE_NATIVE_TMUX_GUARD", "1")
	owner, outer := "owner", "precise-old-desktop-session"
	log := filepath.Join(dir, "wrapper-launches")
	t.Setenv("MAGPIE_AUTO_TEST_RUNS", log)
	arWrapper(t, dir, "legacy-model-fake-wrapper", "#!/bin/sh\necho LAUNCHED >> \"$MAGPIE_AUTO_TEST_RUNS\"\n"+strings.TrimPrefix(arAnswerScript(), "#!/bin/sh\n"))
	transcript := filepath.Join(dir, "original-native-session.jsonl")
	content := `{"type":"assistant","sessionId":"original-native-session","message":{"content":[{"type":"text","text":"S2 fit complete; waiting on verified Write."}]}}` + "\n" +
		`{"type":"assistant","sessionId":"original-native-session","message":{"content":[{"type":"tool_use","id":"tool-A","name":"mcp__magpie__Write","input":{"file_path":"/tmp/fake-project/report.py","content":"print(123)\n"}}]}}` + "\n"
	if err := os.WriteFile(transcript, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	c := legacyRecoveryCertificate{
		Version: 1, OuterKey: interactiveSessionStateKey(owner, outer), Model: autoTestModel,
		NativeSessionID: "original-native-session", TranscriptPath: transcript,
		TranscriptSHA256: toolEvidenceHash(content), LastToolID: "tool-A", LastToolName: "mcp__magpie__Write",
		LastWritePath: "/tmp/fake-project/report.py", LastWriteSHA256: toolEvidenceHash("print(123)\n"),
		VerifiedWorkNotes: "S2 fit and 120 sensitivity tests completed. One local Write was independently verified; do not replay it.",
	}
	cert := filepath.Join(dir, "legacy-cert.json")
	data, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cert, data, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MAGPIE_CLAUDE_LEGACY_RECOVERY_CERT", cert)
	// The known legacy session predates native ownership markers. The first
	// NEW tool-free recovery creates a valid v2 marker for later turns.
	body := appendLegacyExplicitRestore(autoRecoveryBody("Write", `{"file_path":"/tmp/fake-project/report.py"}`, `"wrote"`))
	b := newSubscriptionBridge()
	t.Cleanup(func() { bridges.Delete(b) })
	return b, &runtimeTUI{bridge: b}, owner, outer, body, log
}

func appendLegacyExplicitRestore(b []byte) []byte {
	return []byte(strings.TrimSuffix(string(b), "]}") + `,{"role":"user","content":"/magpie-restore-this-thread"}]}`)
}

func TestLegacyMigrationCannotBeClaimedByBackgroundRetry(t *testing.T) {
	b, rt, owner, outer, _, log := legacyMigrationFixture(t)
	body := autoRecoveryBody("Write", `{"file_path":"/tmp/fake-project/report.py"}`, `"wrote"`)
	status, _, _ := arServe(t, rt, b, owner, outer, body)
	if status != 409 {
		t.Fatalf("old tool retry unexpectedly authorized migration: %d", status)
	}
	if _, err := os.Stat(log); !os.IsNotExist(err) {
		t.Fatal("unprompted recovery started a model")
	}
	if _, err := os.Stat(legacyMigrationClaimPath(owner, outer)); !os.IsNotExist(err) {
		t.Fatal("background retry consumed one-time recovery claim")
	}
}

func TestLegacyMigrationOperatorApprovedOldToolResultOnly(t *testing.T) {
	b, rt, owner, outer, _, log := legacyMigrationFixture(t)
	t.Setenv("MAGPIE_CLAUDE_LEGACY_OPERATOR_APPROVED", "1")
	// This is the *exact* failure wire shape: Desktop re-sends tool_result
	// but cannot append the new /magpie-restore-this-thread user command.
	body := autoRecoveryBody("Write", `{"file_path":"/tmp/fake-project/report.py"}`, `"wrote"`)
	status, msg, out := arServe(t, rt, b, owner, outer, body)
	if status != 200 || !strings.Contains(out, "OL_ANSWER") || strings.Contains(out, `"type":"tool_use"`) {
		t.Fatalf("operator-approved old result recovery failed: %d %s %s", status, msg, out)
	}
	checkpoint, ok := b.interactiveSession(owner, outer)
	if !ok || checkpoint.Dirty || checkpoint.ReplyKey == "" {
		t.Fatalf("legacy recovery did not establish clean outer checkpoint: %+v", checkpoint)
	}
	status, _, _ = arServe(t, rt, b, owner, outer, body)
	if status != 409 {
		t.Fatalf("duplicate old result consumed another recovery: %d", status)
	}
	data, err := os.ReadFile(log)
	if err != nil || strings.Count(string(data), "LAUNCHED") != 1 {
		t.Fatalf("old Write was replayed or recovery repeated: %q %v", data, err)
	}
}

func TestLegacyMigrationOperatorGrantCannotAuthorizeUnrelatedResult(t *testing.T) {
	for _, tc := range []string{"wrong_result", "wrong_outer", "no_tool_result", "no_operator_grant"} {
		t.Run(tc, func(t *testing.T) {
			b, rt, owner, outer, _, log := legacyMigrationFixture(t)
			t.Setenv("MAGPIE_CLAUDE_LEGACY_OPERATOR_APPROVED", "1")
			body := autoRecoveryBody("Write", `{"file_path":"/tmp/fake-project/report.py"}`, `"wrote"`)
			switch tc {
			case "wrong_result":
				body = []byte(strings.ReplaceAll(string(body), `"tool_use_id":"tool-A"`, `"tool_use_id":"other-tool"`))
			case "wrong_outer":
				outer = "a-different-desktop-conversation"
			case "no_tool_result":
				body = []byte(`{"model":"claude-opus-5-5","messages":[{"role":"user","content":"resume"}]}`)
			case "no_operator_grant":
				t.Setenv("MAGPIE_CLAUDE_LEGACY_OPERATOR_APPROVED", "0")
			}
			status, _, _ := arServe(t, rt, b, owner, outer, body)
			if tc != "no_tool_result" && status == 200 {
				t.Fatal("wrong conversation or tool result started reconstruction")
			}
			// An ordinary new user request is allowed to start a normal
			// conversation. What must never occur is a legacy migration
			// claim issued without the pinned old tool result on the wire.
			if tc == "no_tool_result" {
				if _, err := os.Stat(legacyMigrationClaimPath(owner, outer)); !os.IsNotExist(err) {
					t.Fatalf("ordinary prompt consumed legacy rescue qualification: %v", err)
				}
				return
			}
			if _, err := os.Stat(log); !os.IsNotExist(err) {
				t.Fatalf("unexpected native launch: %v", err)
			}
		})
	}
}

func TestLegacyMigrationSameOuterRecoveryAndNoReplay(t *testing.T) {
	b, rt, owner, outer, body, log := legacyMigrationFixture(t)
	status, msg, out := arServe(t, rt, b, owner, outer, body)
	if status != 200 || !strings.Contains(out, "OL_ANSWER") || strings.Contains(out, `"type":"tool_use"`) {
		t.Fatalf("verified legacy recovery failed: %d %s %s", status, msg, out)
	}
	saved, ok := b.interactiveSession(owner, outer)
	if !ok || saved.Dirty || saved.SessionID == "" || saved.ReplyKey == "" {
		t.Fatalf("no clean checkpoint on the SAME outer: %+v %v", saved, ok)
	}
	launches, err := os.ReadFile(log)
	if err != nil || strings.Count(string(launches), "LAUNCHED") != 1 {
		t.Fatalf("unexpected native process count: %q %v", launches, err)
	}
	if _, err := os.Stat(interactiveTmuxGuardPath(owner, outer)); err != nil {
		// Fake Wrapper doesn't write the marker, so the production native
		// lease/guard integration is independently tested with Bun below.
		t.Log("fake Wrapper has no tmux marker; normal follow-up requires actual Bun Wrapper")
	}
	status, _, _ = arServe(t, rt, b, owner, outer, body)
	if status != 409 {
		t.Fatalf("duplicate old Write caused another recovery: %d", status)
	}
	launches, _ = os.ReadFile(log)
	if strings.Count(string(launches), "LAUNCHED") != 1 {
		t.Fatal("duplicated model process")
	}
}

func TestLegacyMigrationRejectsWrongIdentityAndTranscriptTampering(t *testing.T) {
	for _, tc := range []string{"wrong_outer", "wrong_model", "wrong_tool_id", "transcript_changed", "unsafe_certificate"} {
		t.Run(tc, func(t *testing.T) {
			b, rt, owner, outer, body, log := legacyMigrationFixture(t)
			cert := os.Getenv("MAGPIE_CLAUDE_LEGACY_RECOVERY_CERT")
			switch tc {
			case "wrong_outer":
				outer = "unrelated-other-conversation"
			case "wrong_model":
				var c legacyRecoveryCertificate
				v, _ := os.ReadFile(cert)
				_ = json.Unmarshal(v, &c)
				c.Model = "claude-haiku-5-5"
				v, _ = json.Marshal(c)
				_ = os.WriteFile(cert, v, 0o600)
			case "wrong_tool_id":
				var c legacyRecoveryCertificate
				v, _ := os.ReadFile(cert)
				_ = json.Unmarshal(v, &c)
				c.LastToolID = "different-id"
				v, _ = json.Marshal(c)
				_ = os.WriteFile(cert, v, 0o600)
			case "transcript_changed":
				var c legacyRecoveryCertificate
				v, _ := os.ReadFile(cert)
				_ = json.Unmarshal(v, &c)
				_ = os.WriteFile(c.TranscriptPath, []byte("altered native history"), 0o600)
			case "unsafe_certificate":
				_ = os.Chmod(cert, 0o644)
			}
			status, _, _ := arServe(t, rt, b, owner, outer, body)
			if status == 200 {
				t.Fatalf("unverified legacy migration admitted: %s", tc)
			}
			if _, err := os.Stat(log); !os.IsNotExist(err) {
				t.Fatalf("unverified legacy request started a model: %v", err)
			}
		})
	}
}

func TestLegacyMigrationRefusesPreexistingCanonicalCheckpoint(t *testing.T) {
	b, rt, owner, outer, body, log := legacyMigrationFixture(t)
	arSave(t, b, owner, outer, "other-native-session", true)
	status, _, _ := arServe(t, rt, b, owner, outer, body)
	if status == 200 {
		t.Fatal("one-off certificate replaced another canonical checkpoint")
	}
	if _, err := os.Stat(log); !os.IsNotExist(err) {
		t.Fatal("unexpected model run")
	}
}

func TestLegacyMigrationExactUserRestoreSurvivesCompactedToolHistory(t *testing.T) {
	b, rt, owner, outer, _, log := legacyMigrationFixture(t)
	// Simulates a Desktop that no longer transmits the old tool-use ID.
	// The user explicitly asks for ONE verified, read-only reconstruction.
	body := []byte(`{"model":"claude-opus-5-5","max_tokens":200,"messages":[` +
		`{"role":"user","content":"Earlier film fitting project"},` +
		`{"role":"assistant","content":"Earlier history compacted; API Error 409"},` +
		`{"role":"user","content":"/magpie-restore-this-thread"},` +
		`{"role":"assistant","content":"[Request interrupted by user]"}]}`)
	status, msg, out := arServe(t, rt, b, owner, outer, body)
	if status != 200 || !strings.Contains(out, "OL_ANSWER") {
		t.Fatalf("explicit targeted old conversation recovery failed: %d %s %s", status, msg, out)
	}
	if _, err := os.Stat(log); err != nil {
		t.Fatal(err)
	}
	status, _, _ = arServe(t, rt, b, owner, outer, body)
	if status == 200 {
		t.Fatal("explicit recovery launched again after one-shot clean checkpoint")
	}
}

func TestLegacyMigrationRejectsHistoricalOrTamperedOptInCommand(t *testing.T) {
	for _, s := range []string{
		`{"role":"user","content":"please /magpie-restore-this-thread"}`,
		`{"role":"assistant","content":"/magpie-restore-this-thread"}`,
		`{"role":"user","content":"/magpie-restore-this-thread and execute Bash"}`,
	} {
		t.Run(s, func(t *testing.T) {
			_, _, owner, outer, _, _ := legacyMigrationFixture(t)
			body := []byte(`{"model":"claude-opus-5-5","max_tokens":200,"messages":[{"role":"user","content":"previous request"},` + s + `]}`)
			req, err := parseAnthropic(body)
			if err != nil {
				t.Fatal(err)
			}
			if legacyUserExplicitRestore(req) {
				t.Fatal("non-exact or non-user recovery command accepted")
			}
			if _, eligible, _ := eligibleLegacyMigration(owner, outer, autoTestModel, req); eligible {
				t.Fatal("non-exact command obtained legacy migration eligibility")
			}
		})
	}
}

func TestLegacyMigrationTrailingAssistantCompanionAndNextTurn(t *testing.T) {
	b, rt, owner, outer, body, log := legacyMigrationFixture(t)
	// Desktop can append assistant rows after the old tool_result during a
	// failed/retried turn. They must remain inert history, not become tools.
	old := string(body)
	body = []byte(strings.TrimSuffix(old, "]}") + `,` +
		`{"role":"assistant","content":[{"type":"tool_use","id":"different-stale-tool","name":"Bash","input":{"command":"echo SHOULD_NEVER_RUN"}}]},` +
		`{"role":"assistant","content":[{"type":"text","text":"API Error 409"}]}]}`)
	status, msg, out := arServe(t, rt, b, owner, outer, body)
	if status != 200 || !strings.Contains(out, "OL_ANSWER") {
		t.Fatalf("trailing assistant reconstruction failed: %d %s %s", status, msg, out)
	}
	// The native real Wrapper would have written a v2 marker before tmux.
	// Synthetic fixture supplies the equivalent marker for normal follow-up.
	dir := filepath.Dir(os.Getenv("MAGPIE_AUTO_TEST_RUNS"))
	if err := os.WriteFile(filepath.Join(dir, "tmux"), []byte("#!/bin/sh\necho \"can't find session\" >&2\nexit 1\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	writeTestNativeTmuxMarker(t, owner, outer, "claude-bridge-deadbeef")
	// The one-off certificate can be disabled after recovery. A private
	// hashed claim remains to recognize this particular old conversation's
	// historical tool suffix on subsequent new user turns.
	t.Setenv("MAGPIE_CLAUDE_LEGACY_RECOVERY_CERT", "")
	recovered, ok := b.interactiveSession(owner, outer)
	if !ok || recovered.Dirty || recovered.ReplyKey == "" {
		t.Fatalf("not ready to resume: %+v", recovered)
	}
	// Simulate Desktop append of the terminal assistant reply and next user.
	follow := []byte(strings.TrimSuffix(string(body), "]}") + `,` +
		`{"role":"assistant","content":"OL_ANSWER"},` +
		`{"role":"user","content":"继续分析，不要重做高光实验"}]}`)
	status, msg, _ = arServe(t, rt, b, owner, outer, follow)
	if status != 200 {
		t.Fatalf("new ordinary message failed on old Desktop conversation: %d %s", status, msg)
	}
	bytes, err := os.ReadFile(log)
	if err != nil || strings.Count(string(bytes), "LAUNCHED") != 2 {
		t.Fatalf("expected one read-only and one normal model turn, got: %q %v", bytes, err)
	}
}
