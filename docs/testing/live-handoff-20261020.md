# Live recovery and MCP handoff validation — 2026-10-20

This candidate is based on the deployed custom orphan-recovery baseline, including the bounded dirty-thread fix. It does not enable the separate 2 MiB compaction experiment.

## Behavior

- Keep already-authorized tool-free dirty recovery canonical when compaction changes the first-user thread heuristic.
- Recognize the complete Desktop unknown-command fallback template accompanying an explicit recovery marker, with strict duplicate limits and sanitized historical context.
- Accept additive MCP tool definitions only for an exact live call-ID handoff with the original tool schemas, order, context, owner, model, effort and safeguards preserved.
- Wait for the required private MCP inventory before the first native prompt; preserve the foreground callback policy and use a bounded startup wait.
- Surface native synthetic API failures as errors. Preserve authoritative invalid-request metadata and HTTP 400 instead of returning success or retryable 502.
- Log bounded structural rejection reasons without conversation text, tool arguments, secrets or raw identities.

## Verification

The final-source bridge suite passed in 129.202 seconds; focused Go race tests and nine native Wrapper/error-metadata tests passed. Regression coverage includes HTTP tool continuation without starting a replacement native run, tool-free clean checkpoint commits, strict reminder matching, and stale tmux environment overrides.

Production acceptance used real native Claude and MCP helpers through the Mac gateway. Two new independent sessions tested JSON and Anthropic SSE respectively: eight successful requests and four actual Mac read-only executions in total. Each session queried the real working directory, added a file-reading tool during the result handoff, invoked that added tool on the next user turn, and correctly acknowledged a temporary local file's content. SSE message-stop boundaries and clean checkpoints with reply anchors were verified. The original damaged checkpoint was left dirty and unchanged; no historical tool was replayed.

A prior intermediate run hit an upstream reasoning-extraction refusal. It is not counted as passing and was not bypassed; that failure motivated preserving native API-error metadata. Raw production logs, identities, request bodies and local operator scripts are not included here.

## Deployment boundary

The tested production Runtime SHA-256 is `713a8fa8894eba96d7148d2925ba1ff883ff0fdffa5fbb1adc58b93f2e14b50a`. Packaged release executables use the reproducible `-trimpath -buildvcs=false` build contract and therefore have different artifact hashes. The repair files were validated against that deployment. The publication branch also retains main's existing native input-limit error propagation, with its original tests; that combined publication build is separately verified. Deployment backups retain binaries and checkpoints separately; rollback does not overwrite checkpoints.

These tests used an independent HTTP client, not Desktop UI automation. Recovery of the original damaged Desktop conversation and Rewind identity/branch semantics remain unverified. This is not an npm release or a claim that every upstream refusal is fixed.

## Publication checks against current main

The publication branch retains main's native input-limit helper and its original regression tests. All 75 Bun tests pass with the pinned Magpie host contract enabled. All eight platform executables were rebuilt using Go 1.27.1 and the reproducible release flags; the checksum manifest and extracted npm archive pass integrity verification. Raw operator audit files are not part of the branch.

The combined publication tree also passes `go test -race -p 2 ./... -count=1 -timeout=240s` (bridge: 133.329 seconds) and `go vet -p 2 ./...`.
