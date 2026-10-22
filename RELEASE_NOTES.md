# v0.2.13 — completed tool replies are replayed only for the very same request

v0.2.12 answers a repeated delivery of tool results whose reply was already delivered from that stored reply, without starting another native run. It recognised the repeat by the message history alone, so a request with the same history but a different system prompt, tool set, tool schema, model or generation settings could be answered with a reply meant for another request.

- The stored reply is now keyed by a SHA-256 fingerprint of the whole request as the client sent it: account, model, system prompt, tools, messages, tool_choice, thinking and effort, output schema, max_tokens, temperature, top_p, stop sequences, parallel-tool and priority settings. Any difference starts a normal native run.
- Client metadata (such as Claude Code's user_id) is left out, and the fingerprint is taken before Magpie adds its own web-search tool, so a client's true retries — including concurrent ones — are still replayed with no new native run.
- No other behaviour changes; all v0.2.12 protections remain.

Verification: full Go tests and vet, new unit and end-to-end tests for every fingerprint dimension, concurrent retries and searching requests (they fail on v0.2.12 and pass here; two mutations of the fix are caught), and byte-identical rebuilds of all eight Runtime/Helper binaries checked by `scripts/verify-source-binaries.sh`. **Release publication by itself does not restart VPS services or upgrade a running process.**

## Previous release

# v0.2.12 — lightweight sessions, bounded tool parking, and cache-friendly resume

This release promotes the `tui-lite` Runtime and signed Magpie plugin together, including the fixes validated on GTT/NTT production under the same Runtime SHA-256. It builds on all v0.2.11 MCP context and security protections.

- Use the client-provided structured history to reconstruct otherwise unrecoverable conversation turns while keeping signed owner/session routing, live-call tool ownership, a single active native run per canonical conversation, and safeguards. A reconstructed model can still *request* a tool again; this is not a general exactly-once execution guarantee.
- Reject mismatched visible tool-result IDs, protect completed handoffs against duplicate native execution, and handle repeated deliveries without restarting an unsafe tool. Serialize busy main-conversation turns; isolate short auxiliary requests.
- A same-process repeat of an already completed tool result now replays its in-memory completed text answer directly as SSE/JSON, without starting a second native Claude run or emitting a fresh tool call. This is intentionally bounded to the current Runtime process and is not a cross-restart delivery ledger.
- Return native Claude usage limits as HTTP 429 instead of opaque 502, and clean up detached stateless runs on cancellation.
- Hold initial native prompt delivery until the current MCP tool inventory is ready, preventing Claude from hallucinating tool calls when the service has not loaded its tools.
- Reap parked native tool-waiting processes after **five minutes** rather than retaining each for up to 90 minutes; when a legitimate tool result arrives later, resume from that conversation's own native transcript with preserved tool-result structure when safe. The new grace period is a resource policy, not a deadline for client tool execution.
- Reuse a bounded set of working directories for stateless requests and clear their per-turn session artifacts, improving native prefix cache reuse while avoiding accumulating random Claude projects. **This release does not automatically remove existing ~/.claude.json projects or historical sessions**; such cleanup is a separately backed-up operator action.

Verification includes full Go tests and race/vet in CI, packaged-host tests, synthetic signed-MCP/cancellation tests and byte-identical rebuilds of all eight Runtime/Helper platform binaries. On GTT Canary, a live >5-minute tool result resumed after the parked native child was reclaimed; it read 31,180 cached tokens and wrote 6,480 new tokens. Repeated stateless requests showed cache reuse (e.g. 6,286 cache read and 0 cache write in the reported test). These measured outcomes are workload-dependent.

At the time of release preparation the same `12580da` binary build was deployed to GTT and NTT; checkpoint and authentication files stayed on the machines. **Release publication by itself does not restart VPS services, upgrade a running process, or imply all old dirty conversations recover automatically.** Check the final deployed process SHA-256, and never replay ambiguous historical tools.

## Previous release

# v0.2.11 — stable MCP tool growth across successive handoffs

During a live turn, Claude Desktop can add MCP resource tools after the native run has already started. v0.2.10 accepted the first exact-ID handoff and updated the helper's tool set, but retained the earlier context snapshot; a later handoff in the same turn could then return HTTP 409. v0.2.11 advances the stored context only after the expanded tools have been successfully delivered to the existing native run.

The fix preserves tool-result ownership, owner/model validation, the original tool definitions, native-process exclusivity and protection against replaying completed tools. It does not migrate checkpoints or restart a native run.

Validation: the focused Go regression for successive handoffs after dynamic tool growth passes. Release CI performs the packaged-runtime checks and reproducible binary verification.

## Previous release

# v0.2.10 — live MCP handoff compatibility

Includes all v0.2.9 recovery and tool-handoff fixes.

- Continue a verified live tool handoff when only tool-list order, JSON object-key order/whitespace, or the billing header omitted from native instructions has changed.
- Compare Safeguards by JSON content rather than raw formatting; preserve array order and exact numeric values.
- Keep effective system instructions, tool descriptions/definitions, effort, owner/model, history, durable execution records and native-process ownership checks.
- Add boolean-only context and effort difference diagnostics; never log prompts, tool arguments or raw effort values.

Validation: targeted Go race tests passed. The exact Linux artifact passed four real Mac gateway → NTT native Claude/MCP requests and two distinct Mac read-only tool executions, including representation changes during handoff and a new tool on the next turn. The test checkpoint became clean and the original historical dirty checkpoint remained unchanged. Release automation separately verifies package contracts, Go race/vet checks and reproducible platform binaries.

Limits: this is not a claim that the original damaged Desktop session recovered or that the exact field behind the earlier production 409 has been identified. No checkpoint migration, Magpie core upgrade, Science Canary changes or 2 MiB compaction experiment is included.

## Previous release

# v0.2.9 — bounded recovery and reliable live MCP handoffs

This release includes the GTT orphanfix baseline and the complete NTT recovery/handoff fixes, on top of v0.2.8 and main's native input-limit error handling. Machine-local configuration, credentials, recovery certificates and checkpoints remain local.

- Keep already-authorized bounded dirty read-only recovery canonical after Desktop history-prefix changes; retain checkpoint, model and owner checks.
- Recognize only strictly matched Desktop unknown-command reminders around explicit recovery markers, and remove those wrappers from recovery context.
- Accept additive tool declarations during an exact live call-ID handoff while preserving existing schemas, ordering, owner/model, context, effort and replay protection. Do not restart Claude or replay an executed tool.
- Wait for the private MCP tool list before native input, with bounded startup timing and explicit native environment overrides.
- Preserve native API error metadata and input-limit diagnostics; report invalid requests as HTTP 400 rather than successful text or misleading retryable transport errors.
- Add bounded structural rejection diagnostics without prompt bodies or tool arguments. Ship all four Runtime and four MCP Helper platforms with SHA-256 checksums.

Validation: 75 Bun tests, full Go race tests and go vet passed; all eight binaries and the complete installable archive passed integrity checks. The exact Linux artifact was additionally exercised through the real Mac gateway and NTT native Claude/MCP using JSON and SSE: eight successful requests, four actual Mac read-only tool executions, additive tool handoffs and clean new checkpoints. No historical tool was replayed.

Limits: the original damaged Desktop conversation remains unrecovered, Rewind identity/branch continuity remains unverified, and extended long-context/80-minute-idle acceptance is not claimed. This release does not import the separate Science Canary experiments, clear dirty state, weaken recovery admission, or enable the 2 MiB compaction experiment.

## Previous release

# v0.2.8 — Claude Desktop continuity and checkpoint safety

Stable package release of the rc.3 candidate, retaining its underlying Runtime and MCP Helper behavior. The implementation remains unofficial and experimental for complex long-lived Desktop sessions. Limits listed below are still open and are not waived by the stable version label.

 Every production checkpoint lookup now uses the same bounded strict reader as mutations and propagates corruption as an error. A failed dirty-marker write (including a missing checkpoint) prevents the native child from starting. Checkpoint commits sync the temporary file before rename and the containing directory after rename; a failed rename never deletes the previous checkpoint. Updates larger than 16 MiB are rejected before replacement.

Desktop compaction can also change the first user message while the Runtime remembers the old prefix. Previously that prefix mismatch diverted even a valid unique-reply-anchor continuation to an ephemeral helper session. A verified canonical continuation now keeps the original native session and updates the remembered prefix. Unrelated and different-model helper requests retain their isolation.

An unchanged `[Desktop companion, synthetic error]` retry with no new suffix still refuses to resume. The plugin does not infer permission to repeat an earlier tool operation from a client error string. Add a new explicit user continuation only when the saved checkpoint and safe suffix can be verified; uncertain tool outcomes still require reconciliation.

These changes do not provide a cross-process checkpoint transaction, ordinary-turn execution receipts, or a guarantee against storage hardware failure. Real Desktop long-context and extended idle acceptance remain separate gates.

## Previous candidate: v0.2.8-rc.2 — bounded Desktop 502 companion recovery

This is an **isolated candidate, not yet released or production deployed**. It builds on rc.1, without modifying Magpie's core or weakening MCP tool-result replay protection.

The Runtime formerly skipped only the `dirty` form of a Desktop-generated continuation followed by a synthetic 502. `suffix_rejected` and several other recognized persisted-resume failures were left in the suffix as assistant messages, potentially causing the next attempt to return another `suffix_rejected`. The new handling recognizes *only* bounded, text-only `API Error: 502` records paired with the known synthetic Desktop continuation. Any embedded client tool result or native tool call, unrelated assistant message or unverified ordinary user turn still blocks unsafe resume.

The same audit uncovered a companion-resume bypass: the presence of a final Desktop-generated continuation used to take precedence over checkpoint verification. Resume now requires a matching persisted conversation or unique reply anchor, and a suffix containing only the generated continuation plus optional generated token-budget notices. Prior uncommitted user turns, unmatched tool results, unrelated assistant messages and duplicate anchors cannot be discarded to force resume.

Regression evidence also includes a deterministic 120-turn *protocol* replay with repeated historical compaction and synthetic transport errors. It does not substitute for an authenticated 120-turn Claude Desktop run.

Checkpoint persistence has an additional fail-closed integrity gate: a present but corrupted or insecure `claude-interactive-sessions.json` will return a clear HTTP 409 before a new PTY or legacy migration attempt. Previously, invalid data could be silently interpreted as no saved session. Missing state on a genuinely new installation is still supported; do not delete a damaged production store as a "fix" before backing it up and reconciling process ownership.

Follow-up write-path audit: validating only at the HTTP entry point did not protect later checkpoint writes. Internal callbacks previously used a permissive loader and could overwrite a corrupt or insecure store with a single new session after a race or restart. Every production state mutation now reloads and validates the file while holding its in-process store lock, including nested required fields and an upper size bound; damaged bytes remain in place for investigation. This is not a cross-process transactional database or an assurance against host power loss.

For future incidents, rejected persisted resumes also log a bounded, content-free structural diagnostic identifying whether the saved checkpoint and unique assistant reply anchor are visible and whether a stale tool result or intervening assistant response blocks the suffix. The diagnostic does not log prompts, tool inputs/results, account/session identifiers, or hashes; it cannot authorize automatic replay.

New regression tests verify original rejection → corrected continuation, unsafe tool-part negatives, repeated transport failures, and reply-anchor resume after historical compaction. The build-verification helper now uses the exact CI/release reproducibility flags (`-trimpath -buildvcs=false`).

**Limits:** This does not automatically repair all previously failed real Desktop sessions. A `suffix_rejected` caused by an ordinary user turn, unmatched checkpoint, duplicate assistant anchors, unknown tool results, or a dead native MCP callback still fails closed. Native recovery of such a turn requires authenticated provenance of the failed request and may require explicit read-only recovery; blindly deleting an error message would be unsafe. Real 350–500K-token Desktop testing, multi-process NTT/GTT upgrades, SIGKILL and complete 80-minute waits remain separate acceptance gates, not claimed by this patch.

## Previous candidate: v0.2.8-rc.1 — native tmux auto-compaction ownership fix

This is an **experimental pre-release** of the distributable Claude TUI plugin, based on v0.2.7. It is not a claim that every long-session 502 is fixed.

**Bug fixed:** On client-owned Claude Desktop sessions, Go Runtime set `DISABLE_AUTO_COMPACT=1` for the Bun wrapper. A tmux server that predated the wrapper could fail to pass that flag to the actual native Claude Code process. This release explicitly sets `DISABLE_AUTO_COMPACT=1` in the native launch command, and explicitly removes the flag for standalone sessions that should retain native auto-compaction. Tests run the actual native launch shell with both opposite inherited tmux environments.

**Scope:** No Magpie core modifications, no changes to the Go Runtime executable or MCP tool-result replay guard; existing transcript/state formats remain compatible. Existing already-running native Claude children do not receive the setting until their next fresh launch/resume. Never interrupt a real tool operation just to apply this update.

**Unresolved:** Long genuine Desktop `/compact` at 400–500K tokens, process hard-kill recovery, and concurrent native Claude memory pressure remain unproven. The 2026-10-17 NTT 502 involved both client disconnects and severe 1 GiB VPS memory/IO contention, so this targeted fix cannot eliminate every such failure.

To install this exact candidate after publication:

```sh
magpie plugin add github:Guuuu233/magpie-claude-tui-plugin#v0.2.8-rc.1
```

## Previous stable release: v0.2.7 — native Claude quota accuracy and interactive bridge reliability

This is the **non-prerelease v0.2.7** of the standalone `magpie-claude-tui-plugin`, promoted from the tested `v0.2.7-rc.4` candidate without additional Runtime behavior changes. It remains an **unofficial experimental third-party integration**, not a claim that all clients, recovery paths or subscription use cases have been certified. No Magpie source modification is required. **A GitHub Release does not automatically upgrade existing VPS installations.**

The candidate's release checks passed, including offline plugin/MCP integration, Go race tests, packaged-binary/source verification and tarball checks. Real-Claude acceptance on the GTT and NTT VPS deployments is described below. Long real Desktop `/compact`, hard-kill recovery of existing user sessions and a full 80-minute tool wait remain outside the verified scope.

- Native Claude Code `/usage` is the default quota source. Direct OAuth usage calls require an explicit `usageMode: "direct"` option and have a separate cache. No silent fallback to direct OAuth.
- **Quota refresh repair:** native `/usage` now runs with `--output-format json --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence` and parses the authenticated CLI result envelope instead of expecting plaintext at the top level. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is dropped **only from the ephemeral quota-query subprocess** so a VPS service with strict inference privacy can retrieve up-to-date quota windows; `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING` and `DISABLE_AUTOUPDATER` remain set. No ordinary Claude conversation, Desktop transcript, login or runtime is changed by reading quota. An unreadable result still fails closed instead of displaying fabricated zero usage.
- **Authentication error precision:** `/usage` also shows recent request counts. `Last 7d · 403 requests · 62 sessions` must not be mistaken for an HTTP 403 rejection. Numeric HTTP 401/403 is treated as an auth denial only when accompanied by an HTTP/status/error/response indicator; explicit "not signed in" and "Forbidden" errors still fail closed. Reproducible tests cover both cases.
- Keep the original MCP tool callback on an HTTP disconnect even before registration; prevent repeated or delayed disconnect callbacks from terminating a newer continuation. Preserve the existing maximum 90-minute interactive tool wait; no side-effecting tool replay.
- Coordinate long-running tool deadlines: the plugin-owned ephemeral `magpie` MCP server requests an 80-minute call timeout while the native callback has a 90-minute retention ceiling. This prevents the previous 30-minute MCP setting from expiring before the outer live callback; actual Claude Code acceptance and long-duration behavior still require isolated real-CLI canary verification.
- Check the existing per-tmux-child `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` setting using an actual shell launch test. This prevents Claude Code 2.1.212+ from backgrounding a private MCP call instead of returning its synchronous result; the Wrapper already set it, so no redundant Go environment override is introduced.
- Validate the installed package's complete signed MCP handoff with an isolated fake Claude. Wrong tool IDs and replay are safely rejected; real Claude authentication and long-duration behavior remain outside this test's scope.
- Ship `magpie-tui-doctor` as a read-only command to catch duplicate enabled adapters, runtime port drift, file permissions/ownership, and symlinked runtime state. It never handles login credentials or modifies services.
- Test against upstream Magpie v0.1.1268 in the host-compatibility matrix. Fail closed on missing cross-plugin session signatures; never replay uncertain write operations.
- Rebuild and checksum-verify all bundled Darwin/Linux arm64/x64 Runtime and MCP Helper executables before packing. Builds use Go 1.27.1 with `-trimpath -buildvcs=false` to avoid repository revision/dirty-tree stamping changing the binary after a commit; source provenance comes from the tagged Git commit, not embedded VCS metadata.
- Manual GitHub release is now fail-closed: it requires merged `main`, an exact `package.json` version tag, source-identical binaries, all offline integration tests, and a complete unpacked npm install archive. It releases the `.tgz` with its digest alongside the binary assets, without modifying or pushing `main` as a side effect. No release is triggered by this PR.
- For externally supervised systemd runtimes, `runtimePortFile: "/absolute/path/to/runtime/port"` is a plugin-only protection against restart-induced port drift. The host may retain the original `runtimeURL`, but each signed plugin request targets the current local-only port from the owner-private file; malformed or symlinked files fail closed. Two repeatable negative/positive tests cover this behavior.
- **Context authority:** persisted Claude Desktop sessions now own automatic compaction. The private native Claude Code child is started with `DISABLE_AUTO_COMPACT=1`; an explicit Desktop `/compact` remains a separate, tool-free summarization request. One-shot sessions without a stable external session ID keep their native auto-compaction. This does **not** remove the separate native transcript that Claude Code requires for tool-result continuations or guarantee identical token meters: after Desktop rewrites its transcript, native resume is allowed only through the existing proven checkpoint/reply-anchor policy, and unknown/dirty tool history stays fail-closed. Existing already-running native children do not inherit the new environment until their next fresh launch/resume; do not kill or replay live tools to force this change.

**Known host limitation:** Magpie v0.1.1268 invokes hooks from all installed plugins. Two enabled plugins claiming `claude-tui` can still overwrite each other's `x-g3-hook-*` headers in the host. A third-party plugin cannot guarantee host-wide hook isolation. The provider's fetch refuses an invalid proof, and the packaged doctor detects duplicate installs, but a separate upstream host fix is needed to make arbitrary cross-plugin hook interference impossible. **No Magpie core patch is included in this package.**

Deployment status (as of 2026-10-17): the rc.4 candidate was **manually deployed and verified on both GTT and NTT VPS production runtimes**, preserving original states/keys and independent rollback copies. Tested with real Claude subscriptions: signed model response, live MCP continuation, 550 KiB synthetic archival compaction, 130-second tool-result delay, runtime port-drift recovery, and live 5h/7d quota parsing with a 403-request counter. The user's local Mac application and existing Claude Desktop sessions were **not** upgraded. These tests do **not** certify a real 500k-token Desktop `/compact`, hard-kill recovery of a real user session, or a complete 80-minute tool wait. Old orphan tool callbacks continue to fail closed.

## Installation

Use the installable archive attached to this release or install the matching GitHub tag through Magpie's plugin manager:

```sh
magpie plugin add github:Guuuu233/magpie-claude-tui-plugin#v0.2.7
```

If upgrading a systemd-managed runtime, preserve the existing session/key state and update both the plugin spec and the Runtime executable path to the **same** packaged version. Do not restart while real Claude tools are active. Retire old post-start scripts that re-register a prior plugin; ensure exactly one enabled `claude-tui` provider. The archive includes `magpie-tui-doctor` for a read-only preflight.

## Earlier release: v0.2.6 — accurate Claude quota windows

This maintenance release fixes Claude TUI quota cards that stayed stale or showed no account data when the local Claude Code `/usage` output did not contain plan allowance windows. The plugin now reads available OAuth usage windows from the selected Claude profile.

## Changes

- Read the profile's OAuth access token and request current 5-hour, 7-day, and available model-specific utilization from Anthropic's official host.
- Keep successful results in process memory for 60 seconds while preserving Magpie's own quota cache behavior.
- Retain the local CLI `/usage` fallback for profiles whose credentials are stored outside `.credentials.json`.
- Report authentication, network, rate-limit, and response errors without inventing zero usage.

## Data handling and limits

The request is a body-free HTTPS `GET` to `https://api.anthropic.com/api/oauth/usage`. It sends the selected profile's OAuth **access token** only as a bearer credential to `api.anthropic.com`; it does not send prompts, transcripts, or the refresh token. The plugin does not log or return the access token and does not refresh OAuth credentials. This OAuth usage route has no public stability documentation and may change or rate-limit requests. Existing account and Magpie runtime configuration is not replaced by the plugin update.

## Upgrade

Update the plugin on the host that runs Magpie, then refresh its quota page. Installing a GitHub release does not automatically upgrade a plugin already installed on a VPS.

```sh
magpie plugin add github:Guuuu233/magpie-claude-tui-plugin#v0.2.6
```

CI uses synthetic credentials and mock responses; it does not access a real Claude account.
