Experimental, independently maintained Magpie/OpenCode plugin: **not reviewed or approved by Magpie or Anthropic**.

The plugin drives a locally authenticated Claude Code interactive TUI via tmux and forwards tools through MCP. It writes Claude configuration in dedicated working/profile directories, including trust approvals, runtime hooks and bypass-permission settings; review [README.md](https://github.com/Guuuu233/magpie-claude-tui-plugin#exact-security-and-configuration-effects) and your provider's terms before installing. Subscription eligibility is not guaranteed.

This release contains Go Runtime and MCP Helper binaries for macOS/Linux arm64 and amd64 built by GitHub Actions from the corresponding repository source, plus `SHA256SUMS`. The full source is in the repository. No Claude binary or OAuth credential is bundled. Native Windows is not supported.

Install from GitHub: `magpie plugin add github:Guuuu233/magpie-claude-tui-plugin`.

Known limitation: complex history rewrites, interrupted tool handoffs and failed network continuations can return HTTP 409. Do not repeat a potentially executed tool without checking its effects first.
