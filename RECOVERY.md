# Claude TUI crash recovery (experimental)

The plugin handles interrupted native Claude interactive sessions conservatively. When tool execution or delivery is uncertain, the runtime returns HTTP 409 rather than replaying `Write`, `Edit`, `Bash`, or another client-side tool.

Recovery is **off by default**. Optional features include a bounded, checksummed native tool journal (`MAGPIE_CLAUDE_DURABLE_TOOL_JOURNAL=1`), guarded orphan reconstruction (`MAGPIE_CLAUDE_AUTO_RECOVER_ORPHANS=1`), and process/pane fencing (`MAGPIE_CLAUDE_NATIVE_TMUX_GUARD=1`). Optional read-only retry after a crash uses `MAGPIE_CLAUDE_AUTO_RECOVER_RETRY=1`, and first-turn dirty anchors use `MAGPIE_CLAUDE_FIRST_TURN_ANCHOR=1`. No combination of these flags authorizes replay of uncertain side effects.

The runtime uses a per-conversation native process lock inherited by the Wrapper, as well as a private tmux owner marker with the socket-environment fingerprint. If an earlier native process is still active, or its liveness cannot be proven, automatic recovery fails closed. First-turn anchors require an authentic native Session ID and a registered tool callback; completed recovery writes a new clean checkpoint.

Old conversations created before the journal/marker changes **cannot be automatically migrated**. For strictly identified exceptional cases, operators may configure a private certificate with `MAGPIE_CLAUDE_LEGACY_RECOVERY_CERT`, then use an explicit recovery request; an operator-confirmed legacy tool-result handoff has an additional `MAGPIE_CLAUDE_LEGACY_OPERATOR_APPROVED=1` gate. The one-time certificate is checked against the authenticated conversation identity, pinned native transcript, original last tool ID and content hash. It must never be shipped in a public package. A read-only reconstruction is *not* a reattachment to a previously killed MCP callback.

These features have Go tests (including real process SIGKILL and isolated tmux scenarios) and a native Claude isolated-acceptance path, but do not establish general exactly-once tool semantics or a safe migration of all existing sessions. Roll out per fresh conversation, keep backups and preserve old checkpoints and transcripts. See package tests for the expected refusal behavior.

## Managed installation settings

For the normal plugin-center/automatic installation, set any of the five boolean flags above to exactly `1` (enable) or `0` (disable) in the **Magpie server process environment**, then reload the plugin host at an idle boundary. Values are read when that account's managed runtime starts. A client's local shell environment does not configure a Magpie server running on a VPS; services need their own service environment. Exporting a variable after Magpie has already started does not update that process.

The plugin explicitly carries these five flags through the managed supervisor to the runtime. Missing flags remain missing; recovery stays off by default. Values other than `0`/`1` and arbitrary `MANAGED_RUNTIME_EXTRA_ENV` forwarding are not accepted. API credentials and execution overrides remain scrubbed. This does not turn on recovery in the first-connect login helper.

`MAGPIE_CLAUDE_LEGACY_RECOVERY_CERT` and `MAGPIE_CLAUDE_LEGACY_OPERATOR_APPROVED` are deliberately **not** inherited by managed accounts. Exceptional legacy migration requires an operator-configured external runtime; it must never copy a private certificate or approve recovery for newly installed accounts. Do not enable every recovery flag just to match another deployment: use fresh isolated conversations and verify refusals before adopting experimental recovery.
