# Claude TUI crash recovery (experimental)

The plugin handles interrupted native Claude interactive sessions conservatively. When tool execution or delivery is uncertain, the runtime returns HTTP 409 rather than replaying `Write`, `Edit`, `Bash`, or another client-side tool.

## Current behavior (v0.2.12 and later)

Each conversation is served from the history its request carries:

- A request that continues a live or parked native run (its tool results, or what the user said meanwhile) goes on in that native session. The safeguards and opt-in flags in the sections below apply to this path.
- Any other request — after an interruption, a client-side edit or compaction, a restart, or a run reaped after its five minutes parked on tool calls — resumes the conversation's own native transcript when the history follows it, and otherwise starts a native session rebuilt from that history. It is not refused for not matching a checkpoint.
- Tool results whose IDs do not match the tool call visible in the request's last assistant turn are still refused with HTTP 409.
- One conversation runs one native turn at a time: a second request waits up to 60 seconds, then gets HTTP 503 with `Retry-After: 5`.
- Requests without a stable conversation id (titles, classifiers, helper calls) run stateless beside it.
- The same tool results delivered again after their reply was delivered get that reply back without a new native run — only when the whole request is identical (v0.2.13). Any other difference runs normally.
- An exhausted Claude allowance is answered with HTTP 429 (v0.2.13).

A rebuilt model can still *request* a tool again; this is not a general exactly-once guarantee. Check actual files before repeating `Edit`, `Write` or shell commands.

## Checkpoint integrity and empty retries (since v0.2.8)

All checkpoint lookups validate the file at the point of use. Invalid, insecure or oversized state returns HTTP 409; it must not be treated as a new conversation. A native resume also stops if its dirty checkpoint cannot be persisted before launch. Preserve damaged state for investigation rather than deleting it to force a fresh session.

If the client resends exactly a known generated continuation followed by its synthetic error, with no new user content, removing that failed pair leaves an empty suffix. This remains a deliberate refusal and is regression-tested. A client error is not evidence that an ordinary task or tool was never executed; automatic replay remains prohibited without execution provenance.

## Known persisted-resume 502 feedback (since v0.2.8)

On a **clean, completed checkpoint**, Desktop can append an automatically generated continuation and a synthetic HTTP 502 if that continuation failed before the native Claude process started. A later ordinary user turn may then present that synthetic assistant error inside the historical suffix. The plugin can skip the strictly identified, text-only continuation/error pair; it cannot skip arbitrary error messages, old `tool_result`, model-authored responses or an ordinary user turn that failed for an unknown reason. This safety boundary deliberately prevents skipping work that might already have occurred.

The `suffix_rejected` text alone does not establish *why* the original request's history diverged. If the first error involved a real tool result, an unmatched native checkpoint, a missing live callback, or a full Desktop `/compact` rewrite, automatic seamless continuation is not guaranteed. Do not repeatedly Retry/Replay an unknown side-effecting tool. Keep the original Desktop transcript, diagnose the checkpoint and use a deliberate tool-free recovery or a new conversation after read-only verification as appropriate.

Recovery is **off by default**. Optional features include a bounded, checksummed native tool journal (`MAGPIE_CLAUDE_DURABLE_TOOL_JOURNAL=1`), guarded orphan reconstruction (`MAGPIE_CLAUDE_AUTO_RECOVER_ORPHANS=1`), and process/pane fencing (`MAGPIE_CLAUDE_NATIVE_TMUX_GUARD=1`). Optional read-only retry after a crash uses `MAGPIE_CLAUDE_AUTO_RECOVER_RETRY=1`, and first-turn dirty anchors use `MAGPIE_CLAUDE_FIRST_TURN_ANCHOR=1`. No combination of these flags authorizes replay of uncertain side effects.

The runtime uses a per-conversation native process lock inherited by the Wrapper, as well as a private tmux owner marker with the socket-environment fingerprint. If an earlier native process is still active, or its liveness cannot be proven, automatic recovery fails closed. First-turn anchors require an authentic native Session ID and a registered tool callback; completed recovery writes a new clean checkpoint.

Old conversations created before the journal/marker changes **cannot be automatically migrated**. For strictly identified exceptional cases, operators may configure a private certificate with `MAGPIE_CLAUDE_LEGACY_RECOVERY_CERT`, then use an explicit recovery request; an operator-confirmed legacy tool-result handoff has an additional `MAGPIE_CLAUDE_LEGACY_OPERATOR_APPROVED=1` gate. The one-time certificate is checked against the authenticated conversation identity, pinned native transcript, original last tool ID and content hash. It must never be shipped in a public package. A read-only reconstruction is *not* a reattachment to a previously killed MCP callback.

These features have Go tests (including real process SIGKILL and isolated tmux scenarios) and a native Claude isolated-acceptance path, but do not establish general exactly-once tool semantics or a safe migration of all existing sessions. Roll out per fresh conversation, keep backups and preserve old checkpoints and transcripts. See package tests for the expected refusal behavior.

## Historical-message changes during an MCP tool handoff (v0.2.3)

Claude Desktop may add or remove a **standalone generated token-budget reminder** inside a historical user message. A strictly recognized part, exactly matching `<system-reminder><total_tokens>N tokens left</total_tokens></system-reminder>` (including supported line-break variants), can now be normalized for live-tool continuity. User instructions, mixed reminders, tool identities and tool arguments are never normalized away. Not every three-part-to-two-part change is a token-budget notice; unrecognized edits still fail closed.

`MAGPIE_CLAUDE_AUTO_READONLY_HISTORY_DRIFT=1` optionally enables an **independent, tool-free fallback** when a live, exact-ID MCP tool-result callback reaches a changed historical prefix. The fallback requires a matching authenticated outer conversation and model, unchanged safeguards, an actively parked native run, matching canonical thread identity and a *pre-existing Dirty persistent checkpoint*. It terminates the mismatched callback and asks for one fresh read-only reconstruction with every client tool disabled. **It does not return the original tool result to the old Claude process, does not replay the command, and does not guarantee that the original interrupted Desktop turn can always be rescued.** It can spend an additional model turn and may require later manual file/result verification. The option defaults to off.

Enabling this flag is **not** a license to replay unknown `Edit`/`Write`/`Bash` side effects. If there is no exact live callback or eligible Dirty checkpoint, the runtime must still refuse unsafe continuations with HTTP 409. Previously orphaned tool results are not magically made resumable by upgrading the binary. Operator-private legacy migration certificates remain separate and are never distributed.

## Claude Desktop compaction (v0.2.4)

Claude Desktop's dedicated `/compact` request may include completed historical `tool_use` and `tool_result` blocks. The runtime recognizes the compaction protocol and writes user/assistant turns plus structured history into a **separate native Claude Code session** for a tool-free summary turn; any system prompt is included as labelled archival context. It does not replay historical tools or resume/replace the original conversation checkpoint. This only addresses the compaction request shape; unrelated 409/502 failures remain subject to the normal fail-closed behavior.

**Native input-limit diagnostic (since v0.2.9):** A failed native Claude TUI turn may write a synthetic `invalid_request` assistant row followed by `turn_duration`, without invoking the normal Stop hook. The wrapper now recognizes the completed native failure and produces a terminal error instead of waiting for Desktop to time out. The interactive Runtime preserves the original `Prompt is too long` detail and HTTP 400 status when available. This is an error-reporting fix, **not** a larger context window or a guarantee that `/compact` itself will succeed; keep the original Desktop history intact after an input-limit failure. A synthetic, tool-free integration test verifies HTTP 400 in both streaming and non-streaming paths, but it does not replace a real Claude model canary.

To seed this separate session, the full source history, including tool content and images, is written as an additional JSONL transcript under the configured Claude profile and sent through that profile's Claude Code authentication path. The extra local transcript can remain according to the CLI's normal session-retention behavior. Keep the profile private and review its session files if you need to remove the extra copy.

## Managed installation settings

For the normal plugin-center/automatic installation, set any of the six boolean flags above to exactly `1` (enable) or `0` (disable) in the **Magpie server process environment**, then reload the plugin host at an idle boundary. Values are read when that account's managed runtime starts. A client's local shell environment does not configure a Magpie server running on a VPS; services need their own service environment. Exporting a variable after Magpie has already started does not update that process.

The plugin explicitly carries these six flags through the managed supervisor to the runtime. Missing flags remain missing; recovery stays off by default. Values other than `0`/`1` and arbitrary `MANAGED_RUNTIME_EXTRA_ENV` forwarding are not accepted. API credentials and execution overrides remain scrubbed. This does not turn on recovery in the first-connect login helper.

`MAGPIE_CLAUDE_LEGACY_RECOVERY_CERT` and `MAGPIE_CLAUDE_LEGACY_OPERATOR_APPROVED` are deliberately **not** inherited by managed accounts. Exceptional legacy migration requires an operator-configured external runtime; it must never copy a private certificate or approve recovery for newly installed accounts. Do not enable every recovery flag just to match another deployment: use fresh isolated conversations and verify refusals before adopting experimental recovery.
