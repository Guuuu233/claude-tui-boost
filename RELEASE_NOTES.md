# v0.2.6 — accurate Claude quota windows

This maintenance release fixes Claude TUI quota cards that stayed stale or showed no account data when the local Claude Code `/usage` output did not contain plan allowance windows. The plugin now reads available OAuth usage windows from the selected Claude profile.

## Changes

- Read the profile's OAuth access token and request current 5-hour, 7-day, and available model-specific utilization from Anthropic's official host.
- Keep successful results in process memory for 60 seconds while preserving Magpie's own quota cache behavior.
- Retain the local CLI `/usage` fallback for profiles whose credentials are stored outside `.credentials.json`.
- Report authentication, network, rate-limit, and response errors without inventing zero usage.

## Data handling and limits

The request is a body-free HTTPS `GET` to `https://api.anthropic.com/api/oauth/usage`. It sends the selected profile's OAuth **access token** only as a bearer credential to `api.anthropic.com`; it does not send prompts, transcripts, or the refresh token. The plugin does not log or return the access token and does not refresh OAuth credentials. This OAuth usage route has no public stability documentation and may change or rate-limit requests. Existing account and Magpie runtime configuration is not replaced by the plugin update.

## Upgrade

Update the plugin on the host that runs Magpie, then refresh its quota page. Installing a GitHub release does not automatically upgrade a plugin already installed on a VPS.

```sh
magpie plugin add github:Guuuu233/magpie-claude-tui-plugin#v0.2.6
```

CI uses synthetic credentials and mock responses; it does not access a real Claude account.
