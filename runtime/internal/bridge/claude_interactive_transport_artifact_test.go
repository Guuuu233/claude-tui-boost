package bridge

import (
	"fmt"
	"strings"
	"testing"
)

// These are client-visible transport failures, *not* replies written to
// the canonical native Claude transcript. Only a verified tool-free Desktop
// continuation/error pair may be elided from the resume suffix.
func TestRestoreSkipsKnownFailedDesktopCompanionWithoutToolReplay(t *testing.T) {
	for _, reason := range []string{"dirty", "suffix_rejected", "checkpoint_not_found", "context_mismatch", "state_missing"} {
		t.Run(reason, func(t *testing.T) {
			t.Setenv("XDG_CONFIG_HOME", t.TempDir())
			b := newSubscriptionBridge()
			defer bridges.Delete(b)
			owner, outer := "owner", "outer"
			base := []Message{
				{Role: "user", Parts: []Part{{Kind: Text, Text: "hello"}}},
				{Role: "assistant", Parts: []Part{{Kind: Text, Text: "complete answer"}}},
			}
			keys := conversationKeys(owner, base)
			if err := b.saveInteractiveSession(owner, outer, interactiveSessionEntry{
				SessionID: "inner", ConvKey: keys[0], ReplyKey: assistantReplyKey(base[1]), ContextKey: "ctx",
			}); err != nil {
				t.Fatal(err)
			}
			companion := Message{Role: "user", Parts: []Part{{Kind: Text, Text: "Your response above was cut off mid-stream. Resume directly from where it stops — no apology, no recap."}}}
			errorReply := Message{Role: "assistant", Parts: []Part{{Kind: Text, Text: fmt.Sprintf(
				"API Error: 502 NTT VPS Claude: Claude TUI: Claude interactive persisted resume failed: %s; refusing full history replay. This is a server-side issue.", reason)}}}
			user := Message{Role: "user", Parts: []Part{{Kind: Text, Text: "new question"}}}
			msgs := append(append([]Message{}, base...), companion, errorReply, user)
			_, suffix, status := b.restoreInteractiveSession(owner, outer, &Request{Messages: msgs})
			if status != interactiveRestoreExact || len(suffix) != 1 || suffix[0].Parts[0].Text != "new question" {
				t.Fatalf("got status=%s, suffix=%#v", status, suffix)
			}
		})
	}
}

func TestRestoreDoesNotDiscardToolsOrUnprovenAssistantMessages(t *testing.T) {
	base := []Message{
		{Role: "user", Parts: []Part{{Kind: Text, Text: "hello"}}},
		{Role: "assistant", Parts: []Part{{Kind: Text, Text: "complete answer"}}},
	}
	companion := Message{Role: "user", Parts: []Part{{Kind: Text, Text: "Your response above was cut off mid-stream. Continue."}}}
	errorText := "API Error: 502 NTT VPS Claude: Claude TUI: Claude interactive persisted resume failed: suffix_rejected; refusing full history replay. This is a server-side issue."
	failed := Message{Role: "assistant", Parts: []Part{{Kind: Text, Text: errorText}}}
	latest := Message{Role: "user", Parts: []Part{{Kind: Text, Text: "next"}}}
	cases := map[string][]Message{
		"old client tool result":            {{Role: "user", Parts: []Part{{Kind: ToolResult, CallID: "prior-tool", Text: "ok"}}}, failed, latest},
		"companion with hidden tool result": {{Role: "user", Parts: []Part{{Kind: Text, Text: companion.Parts[0].Text}, {Kind: ToolResult, CallID: "prior-tool", Text: "ok"}}}, failed, latest},
		"assistant with hidden tool use":    {companion, {Role: "assistant", Parts: []Part{{Kind: Text, Text: errorText}, {Kind: ToolCall, ID: "tool", Name: "Bash"}}}, latest},
		"normal user and synthetic error":   {{Role: "user", Parts: []Part{{Kind: Text, Text: "perform a real task"}}}, failed, latest},
		"ordinary assistant explanation":    {companion, {Role: "assistant", Parts: []Part{{Kind: Text, Text: "This is not a transport error"}}}, latest},
		"forged embedded 502":               {companion, {Role: "assistant", Parts: []Part{{Kind: Text, Text: "Model said: " + errorText}}}, latest},
		"unbounded error body":              {companion, {Role: "assistant", Parts: []Part{{Kind: Text, Text: errorText + strings.Repeat("x", 16384)}}}, latest},
	}
	for label, suffix := range cases {
		t.Run(label, func(t *testing.T) {
			msgs := append(append([]Message{}, base...), suffix...)
			_, status := conversationSuffixAfterDetailed("owner", msgs, conversationKeys("owner", base)[0])
			if status != conversationSuffixRejected {
				t.Fatalf("unsafe suffix accepted as %v", status)
			}
		})
	}
}

// A long outer history may be compacted while several transport retries are
// already visible in Desktop. Match the last confirmed assistant reply, not
// a rewritten old prefix; discard only proven tool-free failed continuations.
func TestRestoreReplyAnchorAfterLargeCompactionAndRepeated502s(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	b := newSubscriptionBridge()
	defer bridges.Delete(b)
	owner, outer := "owner", "long-outer"
	finalReply := Message{Role: "assistant", Parts: []Part{{Kind: Text, Text: "last committed answer"}}}
	original := []Message{
		{Role: "user", Parts: []Part{{Kind: Text, Text: strings.Repeat("中文LONG_HISTORY\n", 60000)}}},
		finalReply,
	}
	keys := conversationKeys(owner, original)
	if err := b.saveInteractiveSession(owner, outer, interactiveSessionEntry{
		SessionID: "native-original", ConvKey: keys[0], ReplyKey: assistantReplyKey(finalReply), ContextKey: "ctx",
	}); err != nil {
		t.Fatal(err)
	}
	compacted := []Message{
		{Role: "user", Parts: []Part{{Kind: Text, Text: "summary of earlier history"}}},
		finalReply,
	}
	for _, reason := range []string{"suffix_rejected", "suffix_rejected", "dirty"} {
		compacted = append(compacted,
			Message{Role: "user", Parts: []Part{{Kind: Text, Text: "[Your previous response had no visible output. Resume your response from where it stopped.]"}}},
			Message{Role: "assistant", Parts: []Part{{Kind: Text, Text: fmt.Sprintf("API Error: 502 NTT VPS Claude: Claude interactive persisted resume failed: %s; refusing full history replay. This is a server-side issue.", reason)}}},
		)
	}
	compacted = append(compacted, Message{Role: "user", Parts: []Part{{Kind: Text, Text: "continue after compact"}}})
	_, suffix, status := b.restoreInteractiveSession(owner, outer, &Request{Messages: compacted})
	if status != interactiveRestoreReplyAnchor || len(suffix) != 1 || suffix[0].Parts[0].Text != "continue after compact" {
		t.Fatalf("unexpected compacted continuation: status=%q suffix=%#v", status, suffix)
	}
}
