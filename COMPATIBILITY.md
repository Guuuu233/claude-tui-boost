# Compatibility evidence and requirements

See [HOST_COMPATIBILITY.md](HOST_COMPATIBILITY.md) for the current Magpie host boundary, verified commit, automated checks and update precautions. Same runtime source does not imply identical host behavior or model/account configuration.

## Platforms

| Runtime platform | Evidence |
| --- | --- |
| Linux x86_64 | v0.2.12 runs in production on two VPS hosts; v0.2.13 passed a Canary with real Claude model calls. Automatic/SSH login is tested with fake Claude and real tmux, not real new-user OAuth. |
| macOS arm64 | Native build host; isolated plugin/host/runtime/login tests. Current Mac Magpie installation, real OAuth and GUI installation have not been changed or retested. |
| Linux arm64; macOS amd64 | Cross-compiled binaries; no native execution acceptance on these architectures. |
| Native Windows / WSL | Unsupported by this distribution's interactive runtime. A Windows client may connect to Magpie running this plugin on a supported VPS. No Windows launcher is included. |

The runtime/helper binaries for all four macOS/Linux combinations ship in `bin/`. Bun is required for the plugin and vendored TypeScript wrapper, tmux for the native interactive session, and an already installed official Claude Code CLI for login. The automatic connection action prepares tmux and, on macOS when required, Homebrew. Bun suffices for the `.mjs` helpers; a separate Node installation is not required. Automatic subscription status verification requires Claude CLI 2.1.268 or newer and an exact dedicated config-directory match.

Go is required only for rebuilding. Release CI uses Go 1.27.1, `CGO_ENABLED=0` and `-trimpath`; install machines need no Go compiler. The release workflow rebuilds all eight binaries on Ubuntu and requires them to match the committed ones byte for byte; release checksums cover artifact integrity.

## Runtime scope

The packaged runtime preserves production adapter session matching, streamed responses and MCP parked-run semantics. Existing real Linux runtime checks included images in the current message and text continuation. Historic image replay is unsupported. Tool state uncertainty can still return HTTP 409; no general exactly-once or universal recovery guarantee is made. Recovery is opt-in; [RECOVERY.md](RECOVERY.md) explains managed environment settings and private legacy handling.

The automatic setup's default aliases are `sonnet`, `opus`, `haiku`. Actual access and model resolution belong to Claude. Operator-maintained model ids, private prompts, old transcripts, proxy routes and credentials are not shipped as account capabilities.

## Third-party components

- Magpie (MIT): extracted/adapted bridge modules under `runtime/`; notice in `runtime/LICENSE.magpie`.
- The Magpie-adapted claude-bridge wrapper (MIT), based on upstream `@desplega.ai/claude-bridge` 0.2.2: shipped in `vendor/claude-bridge-magpie/`, with LICENSE and ADAPTATIONS.md. Upstream npm wrapper is not interchangeable with these adaptations. Root package declares its `zod` 4.4.3 dependency.
- Official Claude Code CLI: invoked separately as the ordinary user; never packaged or modified by this plugin.
