## v0.2.1 — smoother AI-assisted SSH/VPS login

Headless setup now places the Claude login phase in an isolated private tmux/PTY. If the AI SSH terminal disconnects, reconnecting to the same command retrieves the same login instead of starting another one.

- Structured status reports an official `authorizationURL` for the user to open on their own computer; supports current and legacy official login routes and rejects localhost callback links.
- Returned authorization codes are accepted on stdin, never as arguments. Duplicate submissions and expired sessions are refused.
- Printed control commands provide status, attach, cancel and code submission. `start-detached` supports tools that cannot hold an SSH command open.
- Independent ownership checks keep different login sessions apart. A bounded watcher cleans only the owned tmux server. Unexpected login process exits fail the pending sign-in.
- Retains the dedicated-profile login and runtime-readiness checks from v0.2.0. `authenticated` is explicitly distinct from Magpie's completed connection.

Dependency installation may still need an interactive `ssh -tt` session for system permission prompts. A Magpie host restart or the existing nine-minute deadline ends the pending login. No new public callback ports are opened.

Validation uses real private tmux sessions and fake Claude/authorization codes, plus inspected host RPC and bundled runtime checks. Actual VPS/browser OAuth has not been exercised in this change. See [AI remote setup guide](https://github.com/Guuuu233/magpie-claude-tui-plugin/blob/main/AI_REMOTE_SETUP.md).

**Security and policy:** This is third-party, unreviewed software, not supported by Magpie or Anthropic. It runs an authenticated Claude Code TUI, can modify Claude trust and hooks, and may enable bypass-permissions in its working directory. Subscription account/terms risks remain. See the [security documentation](https://github.com/Guuuu233/magpie-claude-tui-plugin#exact-security-and-configuration-effects).
