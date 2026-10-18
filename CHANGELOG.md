# Changelog

## 0.2.8-rc.2 — isolated recovery candidate (2026-10-18)

- Recognize a narrow set of persisted-resume 502 failures (`suffix_rejected` included) when and only when paired with a tool-free Desktop-generated continuation after the saved assistant checkpoint.
- Reject discarding a purported continuation containing tool results, or a purported transport error containing native tool calls; reject arbitrary assistant/error lookalikes.
- Regression-test long compacted histories, repeated failure artifacts and reply-anchor continuity without replaying previous tools.
- Require checkpoint/unique-reply-anchor verification before treating a Desktop-generated continuation as authorization for native `--resume`; fail closed on unrelated history, ambiguous anchors, old tools or uncommitted user requests.
- Add a deterministic 120-turn checkpoint replay crossing four compacted-history rewrites and seven synthetic 502 transport artifacts. This is not a real model workload.
- Fail closed if a persisted interactive checkpoint file exists but is invalid, unreadable, symlinked, world-readable or incompatible; never reinterpret a broken store as a new native conversation.
- Make the source/binary verification script use the same reproducible Go build flags as CI. No automatic promotion, no modification to existing native session checkpoints.


## 0.2.7 — non-prerelease release (2026-10-17)

- Promote the verified v0.2.7-rc.4 payload to v0.2.7, without changing the shipped Go Runtime, MCP Helper or wrapper behavior.
- Update bilingual landing pages and include both README languages and the technical reference in the installable archive.
- Preserve the experimental/unofficial designation and documented real-Desktop long-session, recovery and platform-test limits.

## 0.2.7-rc series — bundled reliability changes

- Bundle the callback-disconnect fencing fix in the **plugin's own** Go Runtime: late or repeated client cancellation no longer detaches a newer client stream; preserve existing 90-minute interactive tool wait and never replay an external tool.
- Default to native Claude Code `/usage`, with direct OAuth usage an explicit opt-in and isolated caches.
- Ship the `magpie-tui-doctor` read-only deployment checker as part of the plugin package, catching duplicate adapters, stale runtime ports, incorrect file ownership and permissions, and symlinks.
- Build all platform binaries from the plugin's included Runtime source and validate the `SHA256SUMS` manifest during `npm pack`.
- Keep Go builds byte-reproducible across the commit/tag boundary with `-trimpath -buildvcs=false`; CI rebuilds and `cmp`s all eight macOS/Linux binary variants against those shipped in the repo.
- Include an independent, signed loopback end-to-end test using the packaged Runtime and fake Claude (never a real login), enforced in branch/PR CI.
- Add Race-checked fault injection for delayed/repeated cancellation versus new MCP handoff and process completion; run the existing native hard-kill, parallel-tool, auto-recovery and compaction tests together three times in PR CI. All use synthetic tools only.
- Align the ephemeral native MCP server's timeout with the existing 90-minute parked callback lifetime: 80 minutes for a tool invocation, leaving a ten-minute buffer for native resolution and cleanup, rather than allowing an inner 30-minute timeout to orphan an otherwise live client tool result.
- Verify the already-present `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` protection in the vendored Wrapper's actual tmux launch command. Claude Code v2.1.212+ otherwise backgrounds long MCP calls after two minutes, changing the synchronous callback protocol. This is a guard against future Wrapper regression, not a second Go-level override.
- Test a complete signed plugin-to-Runtime MCP round trip with fake Claude: tool_use → native callback registration → matching tool_result → resumed response on the same run. Reject wrong tool IDs and replayed results; no real tools or accounts.
- Harden manual releases: require `main` and an exact `package.json` version tag, never push generated binaries back to `main`, recheck source-to-binary reproducibility and offline integrations, and publish a complete npm `.tgz` plus its digest alongside the Runtime/Helper assets. Publishing still requires a separate manual workflow invocation.
- Supervised external Runtime port discovery: optional `runtimePortFile` reads a private owner-only loopback port file for each signed request. A systemd restart can change the port without leaving Magpie's plugin stranded at the old URL. Invalid, symlinked or publicly accessible files fail closed; the existing endpoint/path/session signing contract remains unchanged.
- Make the **outer client the sole automatic compaction authority** for authenticated, persisted interactive sessions: the plugin-owned Claude Code child receives `DISABLE_AUTO_COMPACT=1`, while standalone one-shot invocations retain native compaction. Explicit Desktop `/compact` still runs as a separate tool-free summarization helper. This prevents an independent native compaction from silently diverging from Desktop's visible summary; the native session still stores tool callback state and safely refuses unmatched historical continuations.
- Add host-compatibility checks for Magpie v0.1.1268, and document that same-provider hook collisions cannot be eliminated solely within a third-party plugin.

## 0.2.6 — accurate Claude quota windows

- Read the selected Claude profile's OAuth access token and request its quota windows from Anthropic's official host so Magpie can show current 5-hour and 7-day utilization.
- Keep a successful result in process memory for 60 seconds and let Magpie retain its own cache behavior; never cache failures as valid quota data.
- Send no prompts, transcripts, or refresh tokens. Do not log or return access tokens, and do not refresh OAuth credentials. Preserve the local CLI `/usage` fallback for profiles whose credentials are stored outside `.credentials.json`.
- Document that the OAuth usage route is not publicly documented and may change or rate-limit requests.

## 0.2.5 — Claude quota cards

- Add Magpie's plugin usage hook so Claude TUI accounts appear in the quota panel and refresh from the local Claude Code `/usage` command.
- Read managed accounts from their own configured Claude profile. The explicit runtime mode uses `claudeConfigDir`, `CLAUDE_CONFIG_DIR`, or `~/.claude` in that order.
- Do not call Anthropic's quota endpoint directly or pass API/OAuth token environment variables to the usage subprocess; report missing CLI, sign-in, and unreadable quota errors instead of fabricated zero usage.

## 0.2.4 — safe Claude Desktop compaction

- Route Claude Code's dedicated Desktop `/compact` request through an isolated, tool-free summary turn, preserving user/assistant turns and structured historical tool results and images; include the system prompt as labelled archival context.
- Seed a separate native Claude CLI session for the summary; do not treat completed historical tool calls as pending work or overwrite the original conversation checkpoint.
- Document the additional local Claude session transcript and the existing Claude Code account path used to summarize it.

## 0.2.3 — historical-message continuity and bounded recovery

- Preserve a live MCP callback across exact, generated token-budget reminder removal from a historical user message; retain strict comparison of user instructions, tool identities, arguments, image payloads and non-budget reminders.
- Add opt-in `MAGPIE_CLAUDE_AUTO_READONLY_HISTORY_DRIFT=1`: only a verified exact live tool ID and same owner/model/safeguards plus an existing Dirty checkpoint and canonical thread permit **tool-free** fallback after history drift. It cannot replay or recover a dead callback.
- Pass the sixth boolean through both managed runtime launch stages (off by default); add regression, race, supervisor-environment and Linux isolated checks.
- Expand English/Chinese README and recovery documentation; publish all four supported Runtime builds with SHA-256 checksums.

## 0.2.2 — managed settings and host compatibility

- Carry five explicit boolean recovery flags through both managed startup boundaries; leave them opt-in. Remove arbitrary supervisor environment forwarding and do not inherit private legacy migration credentials.
- Match unsigned-in model placeholders to the automatic setup's sonnet/opus/haiku aliases; preserve custom models and forward the host's explicit options through the installed entry.
- Include recovery/changelog/host compatibility docs in the package; remove stale Windows launcher and old archive instructions.
- Exercise the actual public entry against real Magpie host code, covering requests, streamed replies, tool-result continuation, account scope, identity refusal and cancellation. Add daily verified/latest-release/main checks and require the verified host tests in release CI.


## 0.2.1 — resilient SSH login

- Run the headless login phase in a private tmux/PTY, with detached cleanup and resumable status after SSH disconnect. Reconnecting never starts a duplicate login.
- Emit restricted official authorization URLs and structured phases; support stdin-only authorization-code submission, attach and cancellation. Never forward localhost callbacks as login URLs.
- Reject code replay, expired sessions and foreign tmux owners; distinguish authenticated Claude from a connected Magpie runtime. Surface crashed helpers as failed sign-ins.
- Add real-private-tmux tests with fake Claude and an AI remote-setup guide; keep current local connection and stored accounts compatible.

## 0.2.0 — automatic first connection

- Add automatic dependency preparation, dedicated profile creation and official interactive Claude subscription login, followed by exact-profile login verification and runtime readiness checking.
- Open a native setup terminal; prepare Homebrew/tmux on macOS or tmux through supported Linux package managers. Preserve interactive OS permission prompts and provide a headless command fallback.
- Keep existing-profile sign-in and stored accounts compatible. Use official CLI model aliases without claiming account entitlement discovery.
- Add hermetic setup, cancellation and actual packaged-runtime tests; retain operator-controlled real OAuth verification.

## 0.1.2 — native TUI tool-wait timeout fix

- Fix a native interactive TUI bug that mistakenly applied the five-minute one-shot tool-result wait limit to long client `Bash`/`Write` calls. In affected turns, the callback was destroyed after five minutes and Desktop retries returned HTTP 409.
- Use a bounded 90-minute interactive tool wait and a 12-hour active native watchdog, matching the wrapper process cap; preserve the five-minute timeout for ordinary one-shot calls.
- Does not retroactively recover terminated tool callbacks; always verify previous tool side effects before continuing.

### Guarded native recovery and one-shot legacy migration

- Extend the native wrapper lifetime cap and MCP handoff safety; record checksummed tool evidence and guard interrupted native sessions against unsafe replay.
- Add opt-in native session file leases, detached tmux owner checks, first-turn dirty anchors and bounded, **tool-free** reconstruction after verified crashes. These options remain disabled by default.
- Add explicit, certificate-bound, one-shot read-only migration for older interrupted Desktop conversations. The original tool call is **never** replayed; operators must independently verify the original transcript and side effects before enabling this path.
- Include automated hard-kill, tmux and recovery regression tests. This release does not promise exactly-once execution or production-safe migration of arbitrary legacy sessions.

## 0.1.1 — long-running MCP tools

- Raise the configured timeout **only for the generated `magpie` MCP server** to 1,800,000 ms (30 minutes); preserve other MCP servers and global Claude Code settings.
- Add a focused test for the generated MCP configuration and helper arguments.
- Responds to native Claude Code terminating a `Bash` MCP call at its former 300-second limit, which subsequently left Desktop awaiting an orphan tool result and returning HTTP 409.
- Long tasks can still be interrupted by Desktop cancellation, lost connectivity or other limits; a previously interrupted tool must not be blindly replayed.

## 0.1.0 — initial independent publication

- Source-only ownership and installation metadata moved from the declined community PR to an independently maintained repository.
- Local loopback runtime / MCP helper binary artifacts rebuilt from matching included Go sources for macOS and Linux (arm64 and amd64), with SHA-256 manifests and a binary-parity script.
- Known limitations: experimental third-party subscription bridge; automatic TUI trust and hook settings; native Windows unsupported; historical session changes can still cause HTTP 409.
- Existing production VPS installations are not modified by publishing this repository.
