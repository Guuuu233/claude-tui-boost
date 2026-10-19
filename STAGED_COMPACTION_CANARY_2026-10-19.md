# Claude Desktop `/compact`: staged Bun Wrapper summarization

**Status:** a separate opt-in experimental feature, default OFF for releases; **enabled on NTT at the operator's request on 2026-10-19**. Built to preserve the NTT custom `orphanfix` Go Runtime while resolving a real ~451K Desktop history that still produced native HTTP 400 after tool-output slimming. **Not yet proven on the full original conversation.**

## Root cause and failed first mitigation

The original `~451.8K/500K` Desktop history was converted into a new native Claude Code JSONL archive. Native Claude returned `invalid_request / Prompt is too long`; the previously merged PR #7 exposed the real error. Subsequent PR #9 opt-in slimming cut historical tool-result text in a real archive from 6,876,308 bytes to 5,316,022 (403 excerpted tool-result text blocks). However, on 2026-10-19 around 12:33 UTC, a new 7.53 MB native transcript with 407 excerpted tool-result blocks still contained `Prompt is too long`. The feature was correctly enabled; the remaining history was still too large for a single native prompt.

Further read-only analysis of the ~5.32 MB archive: user text ~1.14 MB, assistant text ~0.90 MB, tool arguments ~0.61 MB, tool results ~1.14 MB, images ~0.55 MB and JSONL overhead. Additional trimming of tool output would discard increasingly important information without ensuring acceptance.

## Implementation

Files:

- `vendor/claude-bridge-magpie/src/compact-staged-wrapper.ts`: validate archive provenance, partition original history into at most 32 contiguous slices (512 KiB each), **never split a tool_use/tool_result pair**, construct a private synthetic native session for each stage, run the existing Bun CLI's **interactive native Claude Code** path serially, and pass forward a bounded running `<summary>`.
- `vendor/claude-bridge-magpie/src/cli.ts`: opt into the staged orchestrator **only** for authenticated Magpie-generated `--resume` compaction transcripts, with `--output-format stream-json`, the prior slimming validation and a >768 KiB input. Emits a single final `system/init`, `assistant` and `result` envelope to the existing Go Runtime.
- `test/compact-staged-wrapper.test.ts`: regression cases for transaction boundaries, order/content preservation, sequential completion, fail-closed invalid summaries, and cancellation.

Activation on the **Runtime process environment**, not on Desktop:

```text
MAGPIE_CLAUDE_COMPACT_SLIM_HISTORY=1
MAGPIE_CLAUDE_COMPACT_STAGE_WRAPPER=1
```

**Both flags are required. Default stage flag OFF.** Each stage resumes a separate Claude session in a fresh `magpie-claude-pty-stage-*` temp directory. Archived historical messages and tool calls remain inert data. A child explicitly starts with `--tools=` (Claude CLI's empty built-in tool list) and `--strict-mcp-config`, then exits before the next stage. New native tool_use events cause rejection. The parent never emits intermediate summaries to the requesting Desktop. Original Desktop sessions/checkpoints and original imported archival history are not rewritten by this stage operation.

Safety bounds: 512 KiB stage size measured as UTF-8 JSONL bytes (not model tokens); 32 stages max; prior summary <=24 KiB; 5 minutes/stage; 25 minutes for the whole process. Client cancellation terminates active children and prevents later stages. An indivisible pair above the cap fails explicitly; the system never silently removes entire historical messages. Repeated rolling summaries **are lossy** and may drop nuance across many stages; passing tests cannot certify historical fidelity.

## Verification

1. On the previously slimmed real NTT JSONL, **read-only** tool-transaction-aware partition estimation: 512 KiB cap needs approximately **12 stages**; largest indivisible transaction ~280 KiB. This establishes structural feasibility, not native token acceptance.
2. Bun regression tests for the staged path, source and native error-handling: **15/15 passed**, 0 failed. Bun CLI bundle compilation passed.
3. **Real native Claude Opus 5.5 canary on NTT**, fully isolated from production: newly synthesized 820,962-byte archival transcript with an early `PROJECT_COLOR=COBALT` fact, a paired historical Bash tool call/result, and late `NEVER_CHANGE_PRODUCTION` decision. The existing slim feature reduced it to 814,524 bytes. The staged Bun Wrapper used **two sequential native stages**, finished in ~28 seconds, and returned a complete `<summary>` with both markers. Response `subtype=success`, no new tool calls in parent output, and no remaining native Claude processes. The canary only verifies **two synthetic stages**, not the actual ~451K context or 12-stage summary quality.
4. Production `orphanfix` Go binary was neither replaced nor restarted for the isolated test. NTT Magpie and Claude TUI remained active.

## NTT deployment and rollback

After the isolated real-Opus canary, the NTT Runtime was checked at an idle boundary (no Claude or Bun work), and only the **two Bun source files** (`cli.ts` and `compact-staged-wrapper.ts`) were atomically installed in the existing plugin tree. The **custom `0.2.8-rc.3-orphanfix` Go Runtime executable was not replaced**. A new, separate systemd override was installed at `/etc/systemd/system/magpie-tui-runtime.service.d/zzzzzzzzzz-compact-stage-wrapper.conf`, setting `MAGPIE_CLAUDE_COMPACT_STAGE_WRAPPER=1`. The previous PR #9 slim flag remains enabled in its own override.

The Runtime was restarted with systemd. The dependent Magpie gateway needed a short startup interval and subsequently returned HTTP 200 on `/v1/models`. The restarted Runtime process environment contained **both** opt-in flags and the executable still resolved to the original `orphanfix` binary. Independent source hashes matched: `cli.ts` = `71c61f73369d67ccea811854b2565b337df45b743722152f6ebbc0e29aeb2d07` and `compact-staged-wrapper.ts` = `5156977cf7de8b61e5418f73930b8ed001b436d42d0e52ad73ad37100d1d569a`.

The independent pre-deployment backup and rollback script are under `/root/ntt-compact-stage-before-20261019/`. **This rollback only removes the staged feature and restores its previous Wrapper**; the earlier PR #9 slim feature and `orphanfix` executable are left unchanged. At an idle boundary, an authorized operator can run:

```bash
/root/ntt-compact-stage-before-20261019/ROLLBACK.sh
```

Check service status and `/v1/models` again after rollback; do not execute the rollback during any active Claude/Bun work.

**Outstanding production gate:** the original ~451K Desktop conversation has not yet passed `/compact`. It was **not** automatically replayed during deployment. The user should supervise one deliberate attempt, inspect preservation of early decisions, current project paths and unfinished work, and avoid repeated retries on failure. Full 12-stage summaries may take several minutes and consume subscription allowance. The isolated two-stage canary fixture and temporary wrapper directory were cleaned up, and both production services remained active.
