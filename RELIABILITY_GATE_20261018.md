# Claude TUI continuity: test evidence and remaining blockers

_2026-10-18; isolated source candidate v0.2.8-rc.2. Not a claim of parity with native Claude Code._

**Local validation (2026-10-18):** Go 1.27.1 full Race suite and vet passed; targeted combined fault injection including the new restore matrix passed three consecutive Race runs; Bun 67 passed, 2 tests skipped in the default invocation, and the preserved upstream 0.1.1268 host fixture separately passed 20 integration/first-connect tests. Eight platform binaries reproduced exactly, nine asset digests matched, and the v0.2.8-rc.2 npm package passed unpacked verification. No authenticated native-Claude Desktop run was performed.

In the follow-up audit, a 120-turn deterministic checkpoint replay (with four outer-history rewrites/compactions and seven synthetic transport failures) passed. This verifies only the *Go state transition and suffix-matching code*, not 120 real Claude turns or the content quality of any model-generated compacted summary.

## Root-cause finding

`restoreInteractiveSession` establishes an immutable native checkpoint and accepts only the safe new suffix. The helper `claudeDesktopFailedTurnCompanionReply` historically recognized synthetic Desktop 502 history for `dirty` only. A client-generated continuation followed by `suffix_rejected` therefore left an assistant error inside the suffix, which `safeConversationSuffixAfterDetailed` rejected. This creates a demonstrable failure-feedback loop with clean checkpoints. The original NTT failure's *first* trigger remains unverified without contemporaneous VPS logs.

This candidate discards only a _known tool-free Desktop continuation + a bounded text-only transport 502_ immediately following a confirmed checkpoint (or reply anchor), and keeps ordinary user messages and all side-effecting tool history untouched. Invalid shapes remain closed. There is **no automatic retransmission of Write, Edit, Bash or MCP callbacks**.

### Second audit: companion resume cannot bypass checkpoint

After PR #6 initially went green, a second code audit found that `restoreInteractiveSession` treated the last automatically generated Desktop continuation as enough to authorize native resume **before** verifying checkpoint provenance. A new regression suite demonstrated five previously accepted unsafe shapes: unrelated history, old tool result, uncommitted assistant text, ordinary user work before the continuation, and ambiguous repeated reply anchors. The continuation path now insists on matching the cumulative `ConvKey` or **unique** `ReplyKey`, with exactly one semantic continuation message; only strictly generated standalone token-budget system notices may surround it. A synthetic continuation cannot replace a dirty/missing native checkpoint, and it cannot erase a prior user request or tool result. Normal crash continuation and compacted reply-anchor tests remain part of the test matrix.

## Acceptance matrix

| Scenario | Source-level evidence | Real Desktop/VPS evidence still needed |
|---|---|---|
| Clean history, multiple user/assistant turns | Existing resume and checkpoint Go tests | 100+ uninterrupted interactive turns in one Desktop session |
| Synthetic 502 `dirty`, `suffix_rejected`, other known restore failures | New red/green regression and repetition fixture | Capture failing NTT request shape and replay it in an isolated canary |
| Generated Desktop continuation with drifted history | Five red cases before repair; checkpoint/anchor and budget-only-tail tests after | Observe a real interrupted Desktop continuation with authenticated native resume |
| Unknown assistant/error text, embedded old `tool_result`, tool call spoof | New rejection tests | Instrumented full tool callback traces; no duplicate side effects |
| Long pre-compaction history / reply-anchor resume | New >1 MB UTF-8 fixture, plus existing structured compaction test | Actual 350K–500K-token Claude Desktop auto-compact and `/compact` |
| tmux native `DISABLE_AUTO_COMPACT` inheritance | Existing real shell-launch test shipped in rc.1 | Inspect real NTT/GTT native child environment after idle deployment |
| Normal and parallel MCP tool results | Existing Go and signed runtime handoff suites | Authenticated native MCP, with test-only no-op tools |
| Client disconnection and cancellation | Existing disconnect/cancel race and delayed callback tests | Desktop network offline/online with old tool pending |
| Native CLI process SIGKILL and Runtime restart | Existing offline hard-kill/lease/dirty recovery tests | Authenticated canary with durable journal, no external side effects |
| Provider restart, stale runtime port, duplicate plugins | Existing Bun plugin contract and managed-port tests | Verify selected live NTT/GTT plugin/port and source hash |
| Long tool operation and cleanup | Native 80-minute timeout config, offline tests | Full >80-minute no-op wait, deadline race, interruption and restart |
| VPS memory/Swap pressure, orphan Claude processes | Previous field reports of 1 GiB NTT contention; no current instrumentation | Bounded concurrency and process ownership/load audit at live NTT |
| Official Magpie plugin-host identity and hooks | Existing compatibility tests; two tests skipped locally | Full installed-host acceptance on target versions |

## Release gates before claiming near-native behavior

1. **Provenance**: collect the exact original `suffix_rejected` request shape, compare `ConvKey` / `ReplyKey` and sanitized suffix role-part counts, and identify whether an ordinary failed user turn or a synthetic companion caused first divergence. Never record private prompts or authentication material in diagnostics.
2. **Safety**: no duplicate side-effecting tools under any test. A native process that has died during MCP cannot generally have its old callback resurrected by `--resume`; unknown outcomes require read-only reconciliation and explicit user confirmation.
3. **Continuity**: test long Desktop history, forced compaction, several sessions concurrently, network interruptions, SIGKILL, host/Runtime restarts and tool callback timeouts in an isolated environment. Publish recoverability rates, time-to-recover and case-specific failure modes, rather than a blanket parity claim.
4. **Production**: obtain authorized NTT/GTT management access, inspect their **actual** installed binaries and native process ownership, ensure idle windows, record rollback paths and checksum backups, promote one host at a time, and validate the user's real Desktop route. Never assume the published GitHub tag auto-updated the servers.

## Limits of the current patch

A clean checkpoint's **ordinary** user request which failed before starting native Claude is not equivalent to the special Desktop continuation message. The plugin does not yet have signed proof in the next request that such a failed user turn never executed. Automatically dropping that user request can silently lose user work; auto-replaying it could repeat side effects. The durable remedy is a bounded, authenticated failure receipt tied to `(outer session, checkpoint, failed request hash, run generation)` and a no-tools reconciliation option, not indiscriminate skipping of assistant errors. This remains a separately gated engineering change.

Likewise, source-level correctness does not remove the fundamental two-harness context state: Desktop owns external history and compaction, whereas remote Claude TUI keeps a separate native execution transcript. Exact 1:1 behavior cannot be certified until native canary evidence covers these boundaries.
