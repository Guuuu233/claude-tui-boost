## v0.2.0 — automatic installation and Claude login

Install from Magpie Discover, then choose **自动安装并登录 Claude（推荐）** in the Claude TUI provider connection. With official Claude Code v2.1.268+ already installed, the wizard opens a terminal, prepares tmux, creates a private Claude profile, launches official browser login and verifies both subscription login and runtime readiness. No profile paths, ports or connection keys need to be entered.

- macOS: prepares Homebrew when missing through its official interactive installer, then tmux. OS confirmation/password prompts remain interactive.
- Linux desktop: prepares tmux through apt-get, dnf or pacman and opens a supported terminal. Headless/SSH users receive an exact command to run on the server.
- Use Ctrl+C in the setup terminal to cancel. The inspected host does not forward GUI sign-in cancellation to plugin callbacks. Setup is bounded to nine minutes.
- Existing manually connected accounts remain compatible. Official CLI model aliases are routing choices, not verified account entitlements. No inference request is sent during setup.
- Retains all v0.1.2 recovery protections and timeout fixes.

Validation uses isolated fake Claude/installer commands, the actual bundled Runtime and inspected Magpie host RPC. Real-account OAuth, real Terminal permission prompts and each Linux desktop have not been fully exercised. See [first-connect instructions](https://github.com/Guuuu233/magpie-claude-tui-plugin/blob/main/FIRST_CONNECT.md).

**Security and policy:** This is third-party, unreviewed software, not supported by Magpie or Anthropic. It runs an authenticated Claude Code TUI, can modify Claude trust and hooks, and may enable bypass-permissions in its working directory. Subscription account/terms risks remain. See the [security documentation](https://github.com/Guuuu233/magpie-claude-tui-plugin#exact-security-and-configuration-effects).
