# Evidence journal

- Source: `runtime/internal/bridge/claude_interactive_state.go` at `v0.2.8-rc.1`.
- `claudeDesktopFailedTurnCompanionReply` recognizes exactly the `dirty` transport error and misses `suffix_rejected`.
- `safeConversationSuffixAfterDetailed` can strip only *leading* failed companion/error pairs from the suffix. Other assistant messages or tool results are rejected, intentionally.
- `claudeDesktopTurnCompanionMessage` tests for a text prefix without checking whether the same user message contains tool results. Fix must not allow such messages to be silently skipped.
- A 502 feedback loop is reproducible only for matching companion/error pairs; if original 502 came from a normal user turn or a different history shape, this fix alone does **not** prove recovery of that real conversation.
- Reproduced before fix: `TestRestoreSkipsKnownFailedDesktopCompanionWithoutToolReplay` failed on `suffix_rejected`, `checkpoint_not_found`, `context_mismatch` and `state_missing`, with clean `dirty` control passing. After fix all five statuses pass, with seven negative suffix shapes still rejected.
- Added a large historical compact/reply-anchor test with three synthetic transport failures: passes with only one new user message resumed.
- Full `go test ./...` passed (Bridge ~114s); `go vet ./...` passed; `go test -race ./internal/bridge -count=1` passed (Bridge ~118s).
- `bun test`: 67 passed, 2 skipped, 0 failed (69 total). Skipped host-specific tests are not full upstream integration evidence.
- Cross-compiled eight Go executables for Darwin/Linux arm64/amd64 using Go 1.27.1, `-trimpath -buildvcs=false`, updated asset SHA256. Package manifest integrity passed. The old local verify script incorrectly used the default `buildvcs`; red `MISMATCH` before fix and 8/8 `MATCH` after fix.
- Known release boundaries: no verified native 350–500K-token Desktop execution, no 80-minute live MCP wait, no tested SIGKILL/restore against an authenticated native task on this branch, no NTT process/OOM logs as access was unavailable.
- Repeated `go test -race -p 2 ./internal/bridge -run '^(TestInteractiveFaultInjection|...|TestCompaction|TestRestore)' -count=3 -timeout=240s`: passed in 29.95 s.
- `bash scripts/verify-source-binaries.sh`: all 8 binaries MATCH and 9 hashes OK after matching the `-buildvcs=false` release contract.
- `npm pack` as v0.2.8-rc.2 and unpack into a disposable folder: package asset integrity verified, all required release docs present, `ARCHIVE_CONTRACT_OK`.
- Remote `main` verified on 2026-10-18 still points to `e8ef340e...`, exactly the pinned source base of this isolation worktree.
- Final `go test -race -p 2 ./... -count=1 -timeout=240s && go vet -p 2 ./...`: exit 0, Bridge 119.989 s, claudebridge 1.695 s, runtime cmd tests pass.
- Final `bun test`: 67 pass / 2 skip / 0 fail. With the preserved original Magpie v0.1.1268 host.js fixture, host compatibility and first-connect: 20 pass / 0 fail; the two previously skipped host contract checks ran and passed.
