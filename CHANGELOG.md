# Changelog

## 0.1.1 — long-running MCP tools

- Raise the configured timeout **only for the generated `magpie` MCP server** to 1,800,000 ms (30 minutes); preserve other MCP servers and global Claude Code settings.
- Add a focused test for the generated MCP configuration and helper arguments.
- Responds to native Claude Code terminating a `Bash` MCP call at its former 300-second limit, which subsequently left Desktop awaiting an orphan tool result and returning HTTP 409.
- Long tasks can still be interrupted by Desktop cancellation, lost connectivity or other limits; a previously interrupted tool must not be blindly replayed.

## 0.1.0 — initial independent publication

- Source-only ownership and installation metadata moved from the declined community PR to an independently maintained repository.
- Local loopback runtime / MCP helper binary artifacts rebuilt from matching included Go sources for macOS and Linux (arm64 and amd64), with SHA-256 manifests and a binary-parity script.
- Known limitations: experimental third-party subscription bridge; automatic TUI trust and hook settings; native Windows unsupported; historical session changes can still cause HTTP 409.
- Existing production VPS installations are not modified by publishing this repository.
