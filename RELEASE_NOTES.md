## v0.1.2 — interactive tool waits and guarded recovery

Includes the native recovery changes and timeout fix previously available only on main (through commit 162249649af1514aa02a9f62c2769566bc8ba7c8).

- Fix the native interactive tool-result wait accidentally using the five-minute one-shot limit: interactive waits now have a 90-minute bound; ordinary one-shot calls retain five minutes.
- Raise the active interactive native process watchdog to 12 hours. The generated MCP server retains its separate 30-minute timeout; other client and transport limits still apply.
- Add checksummed tool evidence, cross-process file leases, tmux owner checks, first-turn dirty anchors and guarded tool-free crash reconstruction. Recovery options remain opt-in.
- Add certificate-bound, one-shot read-only migration for verified legacy interrupted threads. Original tool calls are never replayed. No private session transcripts or operator recovery certificates are included.
- Build eight runtime/helper binaries for macOS and Linux (arm64/amd64) from published sources in GitHub Actions, with SHA256SUMS.

This release does not revive already terminated callbacks or guarantee that all HTTP 409/502 failures are resolved. Check existing file and command effects before retrying interrupted work. Cross-host bit-identical builds remain unverified (issue #2); the release checksum manifest identifies these specific downloads.

**Security and policy:** This is third-party, unreviewed software, not supported by Magpie or Anthropic. It runs an authenticated Claude Code TUI, can modify Claude trust and hooks, and may enable bypass-permissions in its working directory. Subscription account/terms risks remain. See the [security documentation](https://github.com/Guuuu233/magpie-claude-tui-plugin#exact-security-and-configuration-effects).
