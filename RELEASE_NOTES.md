# v0.2.7 — native Claude quota accuracy and interactive bridge reliability

This is the **non-prerelease v0.2.7** of the standalone `magpie-claude-tui-plugin`, promoted from the tested `v0.2.7-rc.4` candidate without additional Runtime behavior changes. It remains an **unofficial experimental third-party integration**, not a claim that all clients, recovery paths or subscription use cases have been certified. No Magpie source modification is required. **A GitHub Release does not automatically upgrade existing VPS installations.**

The candidate's release checks passed, including offline plugin/MCP integration, Go race tests, packaged-binary/source verification and tarball checks. Real-Claude acceptance on the GTT and NTT VPS deployments is described below. Long real Desktop `/compact`, hard-kill recovery of existing user sessions and a full 80-minute tool wait remain outside the verified scope.

- Native Claude Code `/usage` is the default quota source. Direct OAuth usage calls require an explicit `usageMode: "direct"` option and have a separate cache. No silent fallback to direct OAuth.
- **Quota refresh repair:** native `/usage` now runs with `--output-format json --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence` and parses the authenticated CLI result envelope instead of expecting plaintext at the top level. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is dropped **only from the ephemeral quota-query subprocess** so a VPS service with strict inference privacy can retrieve up-to-date quota windows; `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING` and `DISABLE_AUTOUPDATER` remain set. No ordinary Claude conversation, Desktop transcript, login or runtime is changed by reading quota. An unreadable result still fails closed instead of displaying fabricated zero usage.
- **Authentication error precision:** `/usage` also shows recent request counts. `Last 7d · 403 requests · 62 sessions` must not be mistaken for an HTTP 403 rejection. Numeric HTTP 401/403 is treated as an auth denial only when accompanied by an HTTP/status/error/response indicator; explicit "not signed in" and "Forbidden" errors still fail closed. Reproducible tests cover both cases.
- Keep the original MCP tool callback on an HTTP disconnect even before registration; prevent repeated or delayed disconnect callbacks from terminating a newer continuation. Preserve the existing maximum 90-minute interactive tool wait; no side-effecting tool replay.
- Coordinate long-running tool deadlines: the plugin-owned ephemeral `magpie` MCP server requests an 80-minute call timeout while the native callback has a 90-minute retention ceiling. This prevents the previous 30-minute MCP setting from expiring before the outer live callback; actual Claude Code acceptance and long-duration behavior still require isolated real-CLI canary verification.
- Check the existing per-tmux-child `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` setting using an actual shell launch test. This prevents Claude Code 2.1.212+ from backgrounding a private MCP call instead of returning its synchronous result; the Wrapper already set it, so no redundant Go environment override is introduced.
- Validate the installed package's complete signed MCP handoff with an isolated fake Claude. Wrong tool IDs and replay are safely rejected; real Claude authentication and long-duration behavior remain outside this test's scope.
- Ship `magpie-tui-doctor` as a read-only command to catch duplicate enabled adapters, runtime port drift, file permissions/ownership, and symlinked runtime state. It never handles login credentials or modifies services.
- Test against upstream Magpie v0.1.1268 in the host-compatibility matrix. Fail closed on missing cross-plugin session signatures; never replay uncertain write operations.
- Rebuild and checksum-verify all bundled Darwin/Linux arm64/x64 Runtime and MCP Helper executables before packing. Builds use Go 1.27.1 with `-trimpath -buildvcs=false` to avoid repository revision/dirty-tree stamping changing the binary after a commit; source provenance comes from the tagged Git commit, not embedded VCS metadata.
- Manual GitHub release is now fail-closed: it requires merged `main`, an exact `package.json` version tag, source-identical binaries, all offline integration tests, and a complete unpacked npm install archive. It releases the `.tgz` with its digest alongside the binary assets, without modifying or pushing `main` as a side effect. No release is triggered by this PR.
- For externally supervised systemd runtimes, `runtimePortFile: "/absolute/path/to/runtime/port"` is a plugin-only protection against restart-induced port drift. The host may retain the original `runtimeURL`, but each signed plugin request targets the current local-only port from the owner-private file; malformed or symlinked files fail closed. Two repeatable negative/positive tests cover this behavior.
- **Context authority:** persisted Claude Desktop sessions now own automatic compaction. The private native Claude Code child is started with `DISABLE_AUTO_COMPACT=1`; an explicit Desktop `/compact` remains a separate, tool-free summarization request. One-shot sessions without a stable external session ID keep their native auto-compaction. This does **not** remove the separate native transcript that Claude Code requires for tool-result continuations or guarantee identical token meters: after Desktop rewrites its transcript, native resume is allowed only through the existing proven checkpoint/reply-anchor policy, and unknown/dirty tool history stays fail-closed. Existing already-running native children do not inherit the new environment until their next fresh launch/resume; do not kill or replay live tools to force this change.

**Known host limitation:** Magpie v0.1.1268 invokes hooks from all installed plugins. Two enabled plugins claiming `claude-tui` can still overwrite each other's `x-g3-hook-*` headers in the host. A third-party plugin cannot guarantee host-wide hook isolation. The provider's fetch refuses an invalid proof, and the packaged doctor detects duplicate installs, but a separate upstream host fix is needed to make arbitrary cross-plugin hook interference impossible. **No Magpie core patch is included in this package.**

Deployment status (as of 2026-10-17): the rc.4 candidate was **manually deployed and verified on both GTT and NTT VPS production runtimes**, preserving original states/keys and independent rollback copies. Tested with real Claude subscriptions: signed model response, live MCP continuation, 550 KiB synthetic archival compaction, 130-second tool-result delay, runtime port-drift recovery, and live 5h/7d quota parsing with a 403-request counter. The user's local Mac application and existing Claude Desktop sessions were **not** upgraded. These tests do **not** certify a real 500k-token Desktop `/compact`, hard-kill recovery of a real user session, or a complete 80-minute tool wait. Old orphan tool callbacks continue to fail closed.

## Installation

Use the installable archive attached to this release or install the matching GitHub tag through Magpie's plugin manager:

```sh
magpie plugin add github:Guuuu233/magpie-claude-tui-plugin#v0.2.7
```

If upgrading a systemd-managed runtime, preserve the existing session/key state and update both the plugin spec and the Runtime executable path to the **same** packaged version. Do not restart while real Claude tools are active. Retire old post-start scripts that re-register a prior plugin; ensure exactly one enabled `claude-tui` provider. The archive includes `magpie-tui-doctor` for a read-only preflight.

## Earlier release: v0.2.6 — accurate Claude quota windows

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
