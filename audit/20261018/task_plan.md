# Claude TUI reliability program (2026-10-18)

Goal: bring native-like continuity to long Desktop sessions without ever replaying an unverified tool side effect.

## Gates
- [x] G0: isolate a fresh worktree at `v0.2.8-rc.1`; preserve production and older development trees.
- [x] G1: reproduce and fix known `suffix_rejected` 502 transport-artifact feedback, with strict tool-part and spoofed-error negative tests.
- [x] G2a: audit existing checkpoint/reply-anchor, compaction, tool handoff, cancellation and crash tests; add multiple-error and compacted-history regression fixtures.
- [x] G2b-1: locate and close a generated-Desktop-continuation checkpoint bypass; add red/green regressions and dynamic-budget compatibility.
- [x] G2b-1b: stop malformed or insecure on-disk checkpoint files from being treated as an unknown fresh conversation.
- [x] G2b-1c: add private, bounded and actionable restore failure diagnostics (checkpoint match / reply anchor / old tools); keep error behavior fail-closed.
- [x] G2b-1d: prevent post-preflight checkpoint corruption from being overwritten by internal state mutations; validate nested session entries, symlinks, mode and size under the write lock.
- [x] G2b-1e: propagate strict bounded lookup failures; block native launch on missing/failed dirty persistence; sync state commits and preserve the previous checkpoint on replacement failure.
- [x] G2a-1: reproduce live-Runtime compaction being misclassified as an auxiliary thread; retain canonical native continuity after verified reply-anchor restore and rebind the remembered prefix.
- [x] G2b-2a: specify a provenance-backed ordinary-failed-turn recovery state machine and its SIGKILL/tool safety gates; design only.
- [ ] G2b-2b: implement and verify the durable receipt state machine in a separate opt-in feature PR, then assess long-lived native ownership under memory pressure.
- [x] G3a: run full Bun/Go/race/vet and package integrity checks, repeated fault injections, and rebuild all platform assets.
- [x] G3b (local host only): run upstream Magpie v0.1.1268 host fixture integration without production credentials.
- [ ] G3c: complete real authenticated native + full Desktop integration on an isolated canary.
- [ ] G4: run authorized *real* native Claude/long Desktop canary after network and credential access; determine whether release and staged NTT/GTT promotion are safe.

## Constraints and decisions
- Keep existing provider contract, Go Runtime, native tmux wrapper; no core Magpie edits.
- No bypass of suffix safety checks; synthetic 502 handling must be narrow and must never swallow any ToolUse/ToolResult.
- No production restart, checkpoint editing, credential access or side-effectful retries until canary proves safe.
- Do not claim native equivalence from synthetic tests or a clean CI run.

## Current status
G1, G2a/2a-1, G2b-1/1b/1c/1d/1e, G2b-2a (design), G3a and G3b (local host) have evidence. A local authenticated Haiku canary now covers text, signed MCP handoff, compacted-prefix continuation and idle Runtime restart while retaining the same native Session ID. This is partial G3c evidence; full Claude Desktop integration is still unverified. G2b-2b, full G3c, G4 are not complete. Release candidate version is `0.2.8-rc.3` (not a production deployment).

## Known evidence limits
- Live NTT `/v1/models` returned HTTP 200 on 2026-10-18 but remote SSH log access was unavailable; exact first failing payload remains unobserved.
- Existing safe recovery deliberately requires a dirty checkpoint; a clean checkpoint with an ordinary failed user turn cannot be automatically re-bootstrapped without stronger failure provenance. Do not weaken this gate casually.
