# Changelog

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
