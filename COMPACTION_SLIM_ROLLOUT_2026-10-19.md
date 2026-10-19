# Claude Desktop `/compact`: archival tool-output slimming (2026-10-19)

**Status:** opt-in implementation; deployed on one NTT instance; **not yet accepted for a multi-megabyte / 451K-token production compaction**.

This document covers the **tool-output slimming feature** introduced in `feat/compact-archive-slim-20261019`. It is separate from [PR #7](https://github.com/Guuuu233/claude-tui-boost/pull/7) (report native input-limit failures promptly) and depends on [PR #8](https://github.com/Guuuu233/claude-tui-boost/pull/8) (preserve native error detail when a custom older Go Runtime reads `result` instead of `error`). It does **not** include the other experimental multi-stage summarization implementation.

## 1. Incident and observed cause

On 2026-10-19, a manually initiated `/compact` in Claude Desktop failed with `Error during compaction: Request timed out`. Desktop displayed approximately **451.8K / 500K tokens**. Actual evidence from this incident:

1. Desktop diagnostics showed a compaction request, streaming timeouts, fallback to non-streaming requests and repeated retries over approximately **81 minutes**.
2. The local Magpie router recorded **11** requests toward the NTT Claude TUI provider. They ended with client cancellation / **HTTP 499**, without a recorded first model output.
3. Native Claude Code session files on NTT confirmed that isolated archival histories were imported, but the native model wrote `invalid_request` / **`Prompt is too long`** within seconds. The failure was obscured by wrapper and client timeouts.
4. The separate native archive contained historical `tool_use` / `tool_result` messages and other content. **Desktop's displayed context counter cannot be treated as the token count of the newly constructed native Claude Code transcript**.

PR #7 addresses the **error-reporting** fault; PR #8 adds **legacy Runtime compatibility** for that diagnostic. Neither increases context capacity. This feature addresses a different, remaining cause: excess historical **tool-result text** copied into the isolated compaction input.

## 2. Implementation and activation

The native Runtime already writes a **separate JSONL archive** of the Desktop conversation under the selected Claude profile, then the Bun Wrapper launches Claude Code with `--resume <archive-session-id>` to produce a tool-free summary. The new code runs **before native Claude Code starts**.

Files:

- `vendor/claude-bridge-magpie/src/compact-archive-slim.ts`: validate the archive, excerpt oversized historical tool-result text and atomically replace only the isolated archive copy.
- `vendor/claude-bridge-magpie/src/cli.ts`: invoke the transform only in the narrowly recognized, print-mode, non-forked archival `--resume` path with the explicit environment flag.
- `test/compact-archive-slim.test.ts`: targeted tests for intact user/assistant text, tool-result pairing, image preservation, filesystem safety, rejection of ordinary resumed sessions and Chinese UTF-8 boundaries.
- `RECOVERY.md`: feature switch, safety constraints and acceptance findings.

Activation:

```text
MAGPIE_CLAUDE_COMPACT_SLIM_HISTORY=1
```

**Default: off.** A client-side shell export does not affect a remote Runtime; the flag must reach the Runtime / Wrapper launch environment. Ordinary conversations, unrelated native `--resume` calls, tool execution and checkpoint recovery are **not** supposed to trigger slimming.

### What changes

Only `tool_result.content[]` entries whose type is `text` are candidates. Earlier messages retain up to **1 KiB** of head/tail text, with more head than tail; messages in the most recent **120 archive rows** receive an **8 KiB** budget per candidate block. When shortened, a text block includes its original byte count, SHA-256 digest and an explicit **middle omitted** marker. UTF-8 boundaries are preserved. A block is left unchanged if the excerpt would not reduce its byte size.

### What remains unchanged

All user and assistant messages, tool names/identifiers/arguments, `tool_result` IDs and error flags, image blocks and original message ordering are retained. **Historic tools are never re-executed.** No original Claude Desktop conversation or canonical session checkpoint is rewritten.

### Safety and failure behavior

The Wrapper requires the explicit flag, a recognized compaction instruction and `--resume` without a fork. The archive transform then checks:

- Start/end archival markers, `user`/`assistant` roles, matching session IDs and side-chain flags.
- Every historical `tool_use` has exactly one corresponding `tool_result`; orphaned or duplicated IDs cause refusal.
- The regular-file path is under the selected Claude profile's `projects` directory, in the expected encoded project folder for a dedicated `magpie-claude-pty-*` temporary working directory.
- The archive is not a symlink or multiply linked file, is at most **32 MiB / 12,000 rows**, and has not changed between inspection and replacement.

When content actually changes, the original JSONL is copied into the private Wrapper run directory (mode `0600`), and the shortened archive is written to a separate private file, `fsync`ed and atomically renamed. Validation errors **abort before the native Claude turn is launched**. A failed or already-extended historical transcript must not be rewritten by this path.

This is intentionally **lossy**: SHA-256 helps identify omitted material, but does **not** restore it to the model. An important decision embedded solely in the middle of an old tool response may be absent from the eventual summary.

## 3. Evidence and acceptance boundaries

### A. Real incident archive, offline transformation only

The first **2,241** Go-generated rows were recovered from an already failed NTT native transcript, excluding rows subsequently appended by native Claude Code. The in-memory transform produced:

| Metric | Observed |
|---|---:|
| Input archive bytes | **6,876,308** |
| Output archive bytes | **5,316,022** |
| Reduction | **1,560,286 bytes (~22.7%)** |
| Tool-result text blocks excerpted | **403** |
| Original on-disk failure transcript | **Not modified** |

This is **byte reduction**, **not measured token reduction**. A 5.32 MB archive might still exceed the model's actual native context limit.

### B. Real Opus 5.5 native execution, small synthetic sample

A separate, synthetic six-row archive was created under a new temporary `magpie-claude-pty-*` working directory. A disposable Wrapper copy ran with the flag enabled, then invoked the real Claude Code **Opus 5.5** through its existing authentication path:

| Metric | Observed |
|---|---:|
| Synthetic archive before / after | **47,704 → 11,621 bytes** |
| Tool-result text blocks excerpted | **1** |
| Native resumed summary | **Successful** |
| End-to-end elapsed time | **~28 seconds** |
| Semantic markers | Preserved `COBALT` and the instruction not to modify production |
| New tool calls in native transcript | **0** |

The response returned a complete `<summary>...</summary>`. Test-generated native files, temporary cwd and Wrapper artifacts were removed afterwards. This **does not validate** summary integrity or input acceptance for the real **451K-token** conversation.

### C. Local targeted checks

**10 targeted Bun tests passed**, including native-error compatibility; the Wrapper compiled successfully. The separate PR #7 had previously passed full GitHub CI. **The new slimming branch has not yet completed its own GitHub PR CI at the time of writing.**

## 4. NTT production opt-in, preservation and rollback

After the small real-native canary, the operator explicitly requested deployment. NTT was updated on 2026-10-19:

- Updated **Bun Wrapper source only** within the plugin's existing package tree. The installed production `cli.ts` SHA-256 is `e5071ca308547126f744d738feefee2a7551e89c1de1759b944dd16b8dd52c1a`, and `compact-archive-slim.ts` is `2b3da0967633e0b508eae32f203bd946164277d947d0aaed4c582936087b4ebd`.
- Added `MAGPIE_CLAUDE_COMPACT_SLIM_HISTORY=1` in a separate systemd Runtime override, `/etc/systemd/system/magpie-tui-runtime.service.d/zzzzzzzzzz-compact-slim-history.conf`.
- **Retained** the customized production Runtime binary from `0.2.8-rc.3-orphanfix`, which includes `beginOrphanReadOnlyRecovery` missing from the standard PR #7 binary. Direct replacement would risk regressing existing orphan-session recovery.
- Saved pre-deployment source, unit configuration and a rollback script privately under `/root/ntt-compact-slim-before-20261019/`.
- At an idle boundary, reloaded systemd and restarted **the NTT Runtime**. The dependent Magpie gateway also briefly restarted. Both subsequently became `active/running`, and `http://127.0.0.1:3425/v1/models` and the Tailscale-facing endpoint returned **HTTP 200**. The Runtime process environment contained the enabled flag and the executable path still resolved to the custom `orphanfix` binary.

**Rollback (operator only, at an idle boundary):**

```bash
# Run on NTT as root after checking no active Claude/Bun work is in progress:
/root/ntt-compact-slim-before-20261019/ROLLBACK.sh
```

This restores the pre-deployment Wrapper, removes the new slim module and environment override, reloads systemd and restarts the NTT Runtime. Verify the dependent gateway and `/v1/models` health **after** rollback. Do not use the script during an active session, and do not delete the separate `orphanfix` binary or any original Desktop conversation files.

The production enablement is an **operator-specific, opt-in pilot**, **not** a general release recommendation. GTT and the client's original Desktop transcript were not modified as part of this deployment.

## 5. Remaining risks / release criteria

1. **No complete production `/compact` of the original ~451K-token conversation has passed.** Do not represent the feature as a proven fix for that workload.
2. Loss of information from omitted middle sections is an explicit semantic trade-off. For acceptance, compare the generated summary against known early and late decisions, current file paths, user constraints, error history, and unfinished tasks.
3. Byte thresholds are not token quotas. If native Claude again returns `Prompt is too long`, **do not trigger repeated automatic/manual retries**. Preserve the archival copy and error evidence, and consider a separately validated staged summarization design.
4. A standard upstream deployment must preserve the NTT-specific orphan-recovery logic or roll out alongside a proven replacement; PR #7's standard Go binary alone does not carry this local customization.
5. The feature should remain **off by default** in source packages. Production canaries must be authorized separately; successful small synthetic tests are not authorization for wholesale global enablement.
6. Private historical transcripts, credentials, tokens, debug traces and per-session backups must **not** be included in this PR or any GitHub issue.

## 中文摘要

这次修复针对 Claude Desktop 手动 `/compact` 时，Magpie 将完整历史转为原生 Claude Code 会话，历史工具结果过长导致 `Prompt is too long` 的情况。新增 **默认关闭** 的 `MAGPIE_CLAUDE_COMPACT_SLIM_HISTORY=1`，只在确认是 Magpie 专用压缩副本时，对长工具结果文本保留首尾及哈希摘要；用户消息、助手结论、工具调用参数、配对和图片不改动。真实失败历史离线瘦身约 **22.7%**；真实 Opus 5.5 的 **47 KB 合成样本**通过，且没有重新执行旧工具。NTT 已保留定制 `orphanfix` 并按用户要求启用，生产服务及网关检查正常，有独立回滚脚本。**但原 451K token 长会话尚未成功压缩验证，因此不能把本方案认定为彻底修复。**
