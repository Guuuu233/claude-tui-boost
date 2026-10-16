# v0.2.7-rc.1 — distributable plugin-only reliability candidate

This is a **local, isolated release candidate**, not a published production update. All changes are inside the standalone `magpie-claude-tui-plugin` package (including its bundled Go Runtime). No Magpie application source or live service needs to be edited to install the resulting tarball.

- Native Claude Code `/usage` is the default quota source. Direct OAuth usage calls require an explicit `usageMode: "direct"` option and have a separate cache. No silent fallback to direct OAuth.
- Keep the original MCP tool callback on an HTTP disconnect even before registration; prevent repeated or delayed disconnect callbacks from terminating a newer continuation. Preserve the existing maximum 90-minute interactive tool wait; no side-effecting tool replay.
- Ship `magpie-tui-doctor` as a read-only command to catch duplicate enabled adapters, runtime port drift, file permissions/ownership, and symlinked runtime state. It never handles login credentials or modifies services.
- Test against upstream Magpie v0.1.1268 in the host-compatibility matrix. Fail closed on missing cross-plugin session signatures; never replay uncertain write operations.
- Rebuild and checksum-verify all bundled Darwin/Linux arm64/x64 Runtime and MCP Helper executables before packing.

**Known host limitation:** Magpie v0.1.1268 invokes hooks from all installed plugins. Two enabled plugins claiming `claude-tui` can still overwrite each other's `x-g3-hook-*` headers in the host. A third-party plugin cannot guarantee host-wide hook isolation. The provider's fetch refuses an invalid proof, and the packaged doctor detects duplicate installs, but a separate upstream host fix is needed to make arbitrary cross-plugin hook interference impossible. **No Magpie core patch is included in this package.**

This candidate has not been deployed to GTT/NTT, the local Mac application, or an existing Claude Desktop session.
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
