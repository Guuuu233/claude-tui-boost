# v0.2.3 — Claude Desktop 409 continuity and safe recovery

This maintenance release builds on v0.2.2 and incorporates the latest verified history-drift fix and Chinese README. It is an **unofficial, experimental third-party** provider; not reviewed or endorsed by Magpie or Anthropic.

## Changes

- **History continuity:** Recognize and ignore only a *standalone, exact-format generated token-budget reminder* inside a historical Desktop user message when it disappears during a live MCP tool-result handoff. Genuine user instructions, other reminders, tool IDs/arguments, model/account boundaries and images stay strictly validated.
- **Bounded read-only fallback:** Optionally enable `MAGPIE_CLAUDE_AUTO_READONLY_HISTORY_DRIFT=1` in the Magpie **server's** managed runtime environment. Requires an exact active MCP callback, same authenticated conversation/owner/model/safeguards, and an existing Dirty checkpoint and canonical thread; if historical content cannot safely be reused, it starts a fresh **tool-free** recovery turn rather than replaying uncertain side effects. **Off by default.**
- **Managed install:** Explicitly pass this sixth allowlisted boolean through managed startup; never forward arbitrary environment settings, API credentials, or private legacy-recovery certificates.
- **Documentation:** Chinese-first README, expanded English guidance and RECOVERY.md covering setup, VPS placement, supported platforms, safe tool handoff and compatibility limits.
- **Artifacts:** Source-matched Go Runtime and MCP Helper binaries for macOS/Linux arm64/amd64, with the included `SHA256SUMS` manifest. Long-task timeout protection from v0.1.2 and managed setup improvements from v0.2.2 are retained.

## Limits and safe upgrades

This release does **not** revive a dead MCP callback, automatically re-execute an uncertain `Edit`/`Write`/`Bash`, or guarantee recovery from every HTTP 409/502. Do not retry an interrupted side-effecting tool until the actual files/results are verified. A version upgrade cannot retroactively repair an orphaned tool call. Magpie host and Claude CLI changes can still affect compatibility; see `HOST_COMPATIBILITY.md` and `RECOVERY.md`.

CI uses synthetic/non-inferencing Claude and isolated Magpie host contract tests, not real new-user OAuth or full GUI end-to-end coverage. The source and distributed binaries are not copied from any user's private VPS or native Claude transcript.

### Install / update

```sh
magpie plugin add github:Guuuu233/magpie-claude-tui-plugin#v0.2.3
magpie plugin login claude-tui
```

If already connected, use Magpie's installed-plugin update mechanism after completing active tools, then verify a new, harmless tool-result round trip. Do not reset existing checkpoints or remove a running session solely to upgrade.
