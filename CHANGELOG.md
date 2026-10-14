# Changelog

## 0.1.0 — initial independent publication

- Source-only ownership and installation metadata moved from the declined community PR to an independently maintained repository.
- Local loopback runtime / MCP helper binary artifacts rebuilt from matching included Go sources for macOS and Linux (arm64 and amd64), with SHA-256 manifests and a binary-parity script.
- Known limitations: experimental third-party subscription bridge; automatic TUI trust and hook settings; native Windows unsupported; historical session changes can still cause HTTP 409.
- Existing production VPS installations are not modified by publishing this repository.
