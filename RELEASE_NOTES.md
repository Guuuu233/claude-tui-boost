# v0.2.5 — Claude quota cards

This maintenance release adds the missing Magpie plugin usage hook for Claude TUI accounts. It is an **unofficial, experimental third-party** provider; it is not reviewed or endorsed by Magpie or Anthropic.

## Changes

- Make Claude TUI accounts available to Magpie's quota panel and refresh them with the local Claude Code `claude -p /usage` command.
- Read managed accounts from their own saved Claude profile. Explicit runtime configuration uses `claudeConfigDir`, then `CLAUDE_CONFIG_DIR`, then `~/.claude`.
- Surface a clear quota error when Claude Code is missing, signed out, or returns no readable allowance; do not fabricate a zero-usage reading.

## Data handling

The plugin does not call Anthropic's quota endpoint directly and does not pass API/OAuth token environment variables to the usage subprocess. The local Claude Code CLI uses the selected profile to answer `/usage`; as with Magpie's native Claude quota reader, that CLI may contact its service to retrieve current allowance information. The plugin sends no conversation transcript as part of this usage check.

## Limits and upgrade

This adds quota support for accounts served by this plugin. It does not upgrade an already installed plugin on a VPS and does not change Magpie's built-in Claude quota reader. Update the plugin on the host that runs Magpie, then refresh its quota page. If the card reports an error, check that host's Claude Code installation, sign-in state, and profile directory. CI uses a synthetic local CLI and does not access a real Claude account.

```sh
magpie plugin add github:Guuuu233/magpie-claude-tui-plugin#v0.2.5
magpie plugin login claude-tui
```
