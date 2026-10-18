# Unfinished ordinary turns: provenance-first recovery design

Status: design only. **Not implemented, released, or safe to enable.** Follow-up to PR #6 (`v0.2.8-rc.2`).

## Problem

Claude Desktop can retain `(old user message, assistant API Error: 502)` in its outer transcript. Some of these 502s are known *pre-native-start* refusals (`suffix_rejected`, missing checkpoint), but others may occur after the original native Claude run or external client tools have already acted. The transport error text is not a trustworthy receipt, and historical `tool_result` presence does not prove native callback delivery. Automatically ignoring all assistant errors loses user work; replaying all user work can duplicate side effects. The existing durable MCP tool journal does not attest whether an ordinary user request was admitted or started.

## Minimal durable request state machine

Store a separate owner-private, bounded, atomically written record keyed to an authenticated `(owner, outerSession, selectedModel, checkpoint generation, canonical request digest)`; never log those identifiers or their hashes. Use the same native lease and tmux ownership checks already present rather than inventing an independent execution lock.

`ADMISSION_RECEIVED` → either `PRESTART_REJECTED` (proof that the native start path was **not entered**) or `EXECUTION_UNCERTAIN` (durably written **before** any child start can occur) → `NATIVE_STARTED` → `TOOL_PARKED` / `TOOL_RESULT_VERIFIED` (cross-linked to the existing MCP journal) → `TERMINAL_COMMITTED` (full native result plus durable checkpoint). A crash before the `EXECUTION_UNCERTAIN` write is a pre-start failure **only** when the previous locked checkpoint and a complete negative ownership fence prove no child could have started; absent this proof, fail closed. `PRESTART_REJECTED` cannot be written retroactively based on elapsed time or a user-visible 502 string.

For pre-start errors, persist the exact error class, checkpoint generation and canonical request digest as a **server-side fact**. The next request may classify the historical error as an unexecuted turn only if the receipt, model and owner match, its checkpoint remains unchanged, and the previous request's user content remains byte-for-byte identical. Do not blindly drop that user content. Any attempt to re-execute it must be an **explicit continuation or retry request** with preserved intent, and subject to one live canonical owner claim; if a newer user message cancels or supersedes the task, do not auto-run the old one. Do not interpret a model-authored string beginning `API Error:` as a server receipt.

If state is `EXECUTION_UNCERTAIN`, `NATIVE_STARTED`, `TOOL_PARKED` or has an unverified callback, never auto-replay `Write`, `Edit`, `Bash` or any other effecting operation. The only unattended option is bounded **tool-free** state reconstruction after a verified inactive native process and reconciliation with the durable journal. Otherwise return a clear recovery-required conflict with stable machine-readable reason; do not create a new native session under the same outer thread.

## Persistent-store invariants

- Require version, monotone generation and state transition checks; bound file size, count and retention. Append/fsync and atomic parent-directory durability before spawning, with a recoverable checksum; reject symlink/replaced or partially written state, not an implicit reset.
- A response/client disconnect does **not** prove the native process died or a tool didn't run. Recover the process lease before claiming an orphan, and check tmux guard liveness; retained wrappers can outlive a killed Go Runtime.
- In the absence of an explicit authenticated receipt, current conservative `suffix_rejected` and `409` rules remain in force. Receipt validity is unaffected by Desktop auto-compact and hash-safe token-budget notices, but a compacted prefix alone cannot authorize replay.
- Protect against simultaneous retries from Desktop and an alternate harness, same conversation changing models, old receipt used after a newer completed checkpoint, and replayed claims after process/host restarts.
- Never promise general exactly-once side effects; some external tools lack idempotency keys or rollback. Prefer read-only reconciliation and visible user control when outcome is uncertain.

## Mandatory red/green and live gates

1. Offline tests for valid pre-start rejection → explicit retry exactly once; duplicate/malformed/stale/wrong-owner/wrong-model/wrong-generation receipt; two simultaneous retry clients; new user cancellation; post-compact suffix and pre-existing synthetic 502 history.
2. Deterministic SIGKILL/power-loss barriers **before and after each durable write**, after fork but before first output, while a tool is parked, after a verified client tool result and before native completion, after checkpoint commit but before client delivery. Count native process starts and external effect executions, not merely HTTP success.
3. `go test -race` + repeated offline signed plugin → Runtime → fake/native-shell full callbacks, with a sandbox file-changing tool carrying a unique idempotence sentinel. Reject any second write after any uncertain fault.
4. Isolated authenticated Claude canary on NTT/GTT: inspect actual deployed version and env; 350–500K outer history + real `/compact`; client disappearance mid-MCP, Runtime restart, native wrapper SIGKILL; several concurrent users under 1 GiB/Swap constraints; complete 80-minute no-op MCP wait. Do not mutate the user's current 359K-token conversation for a test.

This design belongs in a separately reviewed feature PR, off by default until all gates pass. PR #6 remains a bounded history-rejection and diagnostics patch, **not** a signed ordinary-turn receipt implementation.
