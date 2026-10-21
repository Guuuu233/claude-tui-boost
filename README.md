<div align="center">

**English** · [简体中文](./README.zh-CN.md)

# Claude TUI Boost

### Make your Claude subscription go further with an interactive TUI

**Bring real interactive Claude Code to Magpie/OpenCode, with persistent sessions and safe MCP tool handoffs.**  
Persistent sessions, streamed responses and MCP tool handoffs—without modifying Magpie itself.

[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Release](https://img.shields.io/badge/release-v0.2.12-blue)](https://github.com/Guuuu233/claude-tui-boost/releases/tag/v0.2.12)
[![macOS / Linux](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](COMPATIBILITY.md)

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
- **See your Claude usage:** The v0.2.7 release reads 5-hour / 7-day usage via the selected profile's native Claude Code `/usage` command.
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

## Quick start

**Requirements:** Magpie with GitHub plugin support; official Claude Code CLI **2.1.268+**; macOS or Linux (arm64/x64). The login flow can prepare tmux; Bun comes from the Magpie host. Native Windows is not supported. Install on the **machine running Magpie and Claude Code** (including a VPS), not just on a remote client.

**1. Install v0.2.8** ([v0.2.7](https://github.com/Guuuu233/claude-tui-boost/releases/tag/v0.2.12)):

```sh
magpie plugin add github:Guuuu233/claude-tui-boost#v0.2.12
magpie plugin login claude-tui
```

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

**Current release:** `v0.2.8` includes native-session continuity and checkpoint safety updates following `v0.2.7`. Complex long-lived Desktop recovery is still experimental; see [release notes](RELEASE_NOTES.md).

## Contribute

Questions and bug reports are welcome in [Issues](https://github.com/Guuuu233/claude-tui-boost/issues); improvements are welcome via [Pull Requests](https://github.com/Guuuu233/claude-tui-boost/pulls). Please remove credentials and private transcripts from reports. If the project is useful, consider giving it a ⭐.
