<div align="center">

**English** · [简体中文](./README.zh-CN.md)

# Claude TUI Boost

### Make your Claude subscription go further with an interactive TUI

**Bring real interactive Claude Code to Magpie/OpenCode, with persistent sessions and safe MCP tool handoffs.**  
Persistent sessions, streamed responses and MCP tool handoffs—without modifying Magpie itself.

[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Upstream release](https://img.shields.io/github/v/release/Guuuu233/claude-tui-boost)](https://github.com/Guuuu233/claude-tui-boost/releases/latest)
[![macOS / Linux / Windows WSL2](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows%20(WSL2)-lightgrey)](COMPATIBILITY.md)

</div>

## Why use it?

**In one Claude Pro + Opus 5.5 comparison, the interactive route consumed 44–50% less 5-hour quota per API-equivalent workload than the tested headless `claude -p` route**—roughly **1.8–2× effective quota efficiency** under those conditions. [See the measurements and methodology discussion →](https://github.com/yetone/magpie/pull/707)

The difference was observed for a specific workload, not across all models or accounts. It does **not** increase your subscription limits or guarantee savings; session continuity and prompt-cache behavior also affect results.

| | Headless workflow in the comparison | With this plugin |
| :-- | :-- | :-- |
| **Execution** | A fresh `claude -p` process per turn | Genuine Claude Code TUI in tmux/PTY, with native session resume |
| **Integration** | Direct print-mode calls | A `claude-tui` provider behind a Magpie-compatible endpoint |
| **Tool handoff** | Headless request lifecycle | MCP tool calls and results bridged back to the calling Agent |
| **Observed quota usage** | Reference baseline | **44–50% less** in the linked *single-workload* test |

### Built for agent workflows

- **Continue across turns:** Reuse an interactive Claude session instead of treating every gateway turn as a fresh conversation.
- **Keep the tools working:** Stream responses and hand off concurrent MCP tool calls/results to your Agent; handle cancellation and bounded recovery.
- **See your Claude usage:** Reads 5-hour / 7-day usage through the selected profile's native Claude Code `/usage` command.
- **Install as a plugin:** The bundled Go Runtime, MCP helper and tmux wrapper run alongside Magpie. No Magpie source patch is required.

```text
Magpie-compatible Agent / SDK client
                │
                ▼
           Magpie gateway
                │
                ▼
      Claude TUI provider plugin
                │
                ▼
     Go Runtime + MCP / tmux bridge
                │
                ▼
       Interactive Claude Code
```

## Fork install — 0.2.19-fork.1

This fork bundles rebuilt Runtime and MCP Helper executables for Linux/macOS on amd64/arm64. The installed package contains both the opt-in history import and Linux zombie-supervisor recovery fix. Install from the fork through Magpie's GitHub plugin entry:

```sh
magpie plugin add github:liangxyz/claude-tui-boost
```

In Magpie's web UI, install or update `github:liangxyz/claude-tui-boost` and confirm package version `0.2.19-fork.1`. Keep `MAGPIE_CLAUDE_HISTORY_IMPORT=1` in the Magpie service environment to enable archive-style rebuilding; normal verified native continuation stays unchanged. History import has a 512 KiB UTF-8 prompt budget and supports inline images through the existing private MCP reader. See [Recovery](RECOVERY.md) for behavior and limits.

For Docker, preserve the existing `/config` mount and enable `init: true` (Compose) or `--init` (docker run) when recreating the container. Update at an idle boundary and preserve the selected Claude profile. Previously installed local `bin/magpie-tui-runtime` overrides take precedence over platform files; the package's rebuilt platform Runtime is the normal managed entry.

`package-assets.json` is the fork's executable inventory: package/toolchain version, target format/architecture and byte counts. Packing checks inventory completeness, regular executable files and target headers; Linux startup and installation behavior are checked separately. Content digests are outside this fork's packaging contract. Cross-compiled macOS and arm64 artifacts still require native-environment acceptance for those targets.

## Upstream quick start (v0.2.18 reference)

**Requirements:** Magpie with GitHub plugin support; official Claude Code CLI **2.1.268+**; macOS, Linux (arm64/x64), or Windows with WSL2 (having `bun`, `tmux` and `claude` inside the default WSL2 distribution). The login flow can prepare tmux; on Windows, the plugin automatically bridges into WSL2 via `wsl.exe`. Install on the **machine running Magpie and Claude Code** (including a VPS), not just on a remote client.

**1. Install upstream** (upstream reference release: [v0.2.18](https://github.com/Guuuu233/claude-tui-boost/releases/tag/v0.2.18)):

```sh
magpie plugin add github:Guuuu233/claude-tui-boost
magpie plugin login claude-tui
```

The main branch is kept at the latest published release, so Magpie shows an update in **Plugins** whenever a new one is out (or run `magpie plugin update`). Leave out a `#tag`: a tag never moves and Magpie would never offer an update. Updating restarts the plugin host, which restarts the managed runtime, so update between tasks. Installed earlier with `#v0.2.x`? Run the command above once to switch.

**2. Connect Claude.** In Magpie, open the **Claude TUI** provider and choose **Auto install & sign in to Claude** (shown in Chinese as “自动安装并登录 Claude”). Complete the official Claude browser login when prompted. A dedicated Claude profile is created; the advanced “Connect already signed-in Claude” option is also available.

**3. Select the provider in your Magpie-routed client.** Choose the configured Claude TUI model (typically `sonnet`, `opus` or `haiku` aliases), then test a normal response and a harmless tool round-trip. These aliases do not grant model access.

**Important:** Installing the plugin does **not** intercept a standalone `claude -p` command or automatically reconfigure the Claude Agent SDK. The client must explicitly route compatible requests through Magpie. Check [First connection](FIRST_CONNECT.md) and [VPS/SSH setup](AI_REMOTE_SETUP.md) when needed.

> **Please read before installing:** This is an **unofficial experimental third-party plugin**. Using a personal Claude subscription through other agents may violate applicable terms and can lead to account restrictions. The [upstream proposal was declined](https://github.com/yetone/magpie/pull/707). The plugin can launch Claude with reduced permission prompts; use a dedicated profile in a trusted environment. [Technical and security details](TECHNICAL_REFERENCE.md#exact-security-and-configuration-effects) · [Recovery limitations](RECOVERY.md). For a formally authorized SDK integration, use Anthropic's official API.

## Documentation

| Guide | What you'll find |
| :-- | :-- |
| [First connection](FIRST_CONNECT.md) · [Remote/VPS setup](AI_REMOTE_SETUP.md) | Login, browser authorization, tmux and remote installation |
| [Compatibility](COMPATIBILITY.md) · [Magpie host compatibility](HOST_COMPATIBILITY.md) | Platforms, tested boundaries and host upgrades |
| [Recovery](RECOVERY.md) | Interrupted requests, 409/502, opt-in recovery and tool safety |
| [Technical reference](TECHNICAL_REFERENCE.md) | Advanced configuration, exact security effects, tests and builds |
| [Release notes](RELEASE_NOTES.md) · [Changelog](CHANGELOG.md) | What's new and what remains experimental |

**Upstream release reference:** `v0.2.18` verifies the full conversation prefix before resuming a checkpoint on the lite path and preserves a replacement run's `liveOuter` ownership when a superseded run finishes (#27, #28). `v0.2.17` adds 1-hour prompt-cache breakpoints on rebuilt sessions, automatic stale supervisor lock recovery after host reboot, and `/usr/sbin/nologin` service-account compatibility (#21, #22, #23). `v0.2.16` adds `win32` to `package.json#os` so npm/Bun on Windows installs the plugin without `--force` and refreshes documentation across all guides (`v0.2.15` added the Windows WSL2 automatic bridge). `v0.2.14` accepts requests up to 32 MiB (long, image-heavy conversations) and answers larger ones with 413 rather than a retried 502. `v0.2.13` replays a completed tool reply only for the very same request and answers an exhausted Claude allowance with 429 instead of 502. Since `v0.2.12` each conversation is served from its own history: an interrupted or rewritten conversation is rebuilt rather than refused. Tool-replay boundaries in long, complex sessions remain experimental; see [release notes](RELEASE_NOTES.md).

## Contribute

Questions and bug reports are welcome in [Issues](https://github.com/Guuuu233/claude-tui-boost/issues); improvements are welcome via [Pull Requests](https://github.com/Guuuu233/claude-tui-boost/pulls). Please remove credentials and private transcripts from reports. If the project is useful, consider giving it a ⭐.
