# Live MCP context compatibility acceptance — 2026-10-21

Source fix: `4ff8598` (includes boolean-only context diagnostics from `37cd334`).

The live handoff check now accepts tool-list reordering, JSON object-key/whitespace changes, and billing-header changes already omitted from native instructions. Safeguards compare JSON content while retaining array order and exact numeric representations. Effective system instructions, tool definitions/descriptions, effort, ownership, history, durable tool records and exclusive native ownership remain checked. Persisted checkpoint fingerprints were not migrated.

Validation:
- Targeted Go race tests passed in 2.881 seconds, including changed-policy rejection and HTTP additive-tool handoff without starting a replacement process.
- Deployed Linux amd64 Runtime SHA-256: `d4fcd3565dac4b554e9733c168d24eb78fa950953072806eb0606ec3b59a1011`.
- Actual Mac gateway → NTT native Claude → Mac read-only tools → continuation: four HTTP 200 responses, two distinct client tool executions, no repeated client execution. Handoffs changed tool order, schema key order and billing metadata. A newly added tool worked on the following turn.
- The acceptance session committed a clean checkpoint. The original historical dirty checkpoint remained unchanged. Runtime and gateway are active.

The first acceptance attempt met a connection reset before any tool executed because stopping Runtime also stopped the dependent gateway. Starting the gateway restored its endpoint before the successful acceptance run.

This proves the tested compatibility paths, not recovery of the user's original damaged Desktop session or identification of the exact field behind the earlier production 409. This is a candidate branch deployment, not a new tagged release. Private deployment receipts and an independent binary rollback are retained on NTT; rollback does not restore checkpoints.
