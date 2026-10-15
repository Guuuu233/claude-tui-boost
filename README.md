# Claude TUI for Magpie — unofficial third-party plugin

**Independent, experimental, not approved or reviewed by Magpie, Anthropic or the `magpie-community/plugins` maintainers.**

This provider uses a locally installed, already signed-in Claude Code **interactive TUI** through a tmux-based wrapper. It routes requests from Magpie/OpenCode through that TUI and bridges the caller's tools via MCP. Provider ID: `claude-tui`. It is **not** an official Anthropic API client, and it does not distribute Claude Code or copy your OAuth token into another process's API key.

> **Account and policy warning.** Using a Claude consumer subscription through other tools may not be permitted for your plan or use case and may result in usage charges, access restrictions or account suspension. Having a signed-in Claude Code session does not itself authorize third-party API-style usage. Verify current Anthropic terms yourself; use the official API if your usage requires an authorized integration. This project makes no compliance guarantee.

## Installation (from GitHub, not the community registry)

Requirements: Magpie with GitHub plugin installation support, official Claude Code **v2.1.268 or newer** installed, and macOS or Linux (arm64 / x86_64). Bun is supplied by the Magpie plugin host. The automatic connection flow prepares tmux and a dedicated Claude profile; native Windows is unsupported. The plugin/runtime and Claude Code must run on the same machine; installing on a Mac does not update a VPS.
```sh
magpie plugin add github:Guuuu233/magpie-claude-tui-plugin
magpie plugin login claude-tui
```

Alternatively, find **magpie-claude-tui-plugin** under **Plugins → Discover → Unofficial** (GitHub repositories tagged `magpie-plugin`). This GitHub discovery entry does **not** mean the Magpie project reviewed it. The package is not published in the `@magpie-community` npm organization.

After installation, open the **Claude TUI** provider connection and choose **自动安装并登录 Claude（推荐）**:

1. A visible terminal opens and prepares tmux. On macOS, missing Homebrew is installed through its official interactive installer; on Linux, supported package managers are apt-get, dnf and pacman. System password/installer confirmation prompts remain interactive.
2. Official `claude auth login --claudeai` opens the browser. Complete authorization there; paste a code into the terminal only if the official CLI asks for one.
3. The plugin checks subscription login in its newly created private profile, starts the bundled runtime and verifies its readiness before saving the local connection.

No profile paths, ports or connection keys need to be entered. Models use official CLI aliases `sonnet`, `opus` and `haiku`; these are routing choices, **not** a discovered list of account entitlements. Claude enforces model access. The setup does not send a paid inference request.

The existing **连接已登录 Claude** method remains available for advanced users: supply a dedicated profile directory and actual model IDs yourself. Existing stored accounts remain compatible. See [首次连接说明（中文）](FIRST_CONNECT.md) for permission prompts, cancellation and headless Linux. For AI-assisted VPS setup, see [AI_REMOTE_SETUP.md](AI_REMOTE_SETUP.md): a private tmux login survives SSH disconnects, reports an official `authorizationURL`, and accepts a returned code only on stdin. Keep Magpie's local auth state private.

## Exact security and configuration effects

**Read this before installing.** Installing from GitHub runs **third-party code** under your Magpie process account. The automatic flow starts the managed runtime after verified login; the advanced flow starts it on the first request and uses a local loopback listener, a private key file and a per-account state directory. There is **no npm postinstall script**, but its runtime actively starts processes and writes configuration:

- The automatic connection action may install Homebrew/tmux using the system package manager, opens a terminal, and creates a fresh private Claude profile under plugin-owned state. Claude performs OAuth and stores its credentials there; the plugin never copies the main profile. No dependency installer runs just from loading/installing the plugin.
- Its vendored `claude-bridge-magpie/src/preaccept.ts` **writes the selected Claude config directory's `.claude.json`**, pre-accepting project trust and MCP approvals for the runtime's work directory. It makes a `.claude-bridge-backup` on the first modification.
- Its vendored `hook-install.ts` **installs runtime hooks** in `.claude/settings.local.json` inside the generated work directory in the managed user-context path. Other CLI paths may write Claude's global `~/.claude/settings.json`. Inspect your actual environment before enabling them.
- The wrapper enables `bypassPermissions` and `skipDangerousModePermissionPrompt` in the runtime work directory for non-root sessions, and can **automatically accept startup dialogs and send keystrokes in tmux**. A Claude TUI started this way can run without its normal interactive confirmation prompts. **Do not select your main Claude profile; use a dedicated, isolated profile and machine account.**
- The CLI/MCP runtime returns tool calls to the calling Agent for execution. Commands or edits approved by that Agent may alter files accessible to the Agent. A request whose tool execution state is uncertain is intended to fail closed; this is experimental, not a guarantee.
- The four-platform precompiled Go Runtime and MCP Helper binaries are shipped in `bin/`. Their Go sources are in `runtime/`; review them or build them locally before trusting them. The wrapper is vendored TypeScript in `vendor/` and requires Bun. No built-in telemetry or background model calls are intentionally added, but inspect code before use.

**Do not share** Claude configuration, Magpie authentication files, runtime keys, session transcripts, or debug logs. Do not expose the loopback runtime or Magpie gateway to untrusted networks. Use a private machine/VPS, and do not run arbitrary downloaded plugins with production secrets without reviewing them.

## How it works and what remains unsupported

The bridge keeps a Claude Code process alive across turns and translates MCP `tool_use`/`tool_result` between Claude and the calling Agent. It supports streaming, cancellation, parallel tools and read-only recovery of certain interrupted conversations. Because the Desktop and CLI can reshape historic messages, some tool handoffs can still return HTTP 409 rather than risk executing a tool twice. Never blindly repeat `Edit`, `Write` or shell commands after an interrupted turn; check actual files first.

Current user-message images are supported; historic image replay is not. macOS arm64 and Linux amd64 have received limited local/remote runtime checks; macOS amd64 and Linux arm64 builds are cross-compiled only. Windows-native PTY execution is not supported. See [COMPATIBILITY.md](COMPATIBILITY.md). Experimental crash recovery and strict legacy-migration gates are described in [RECOVERY.md](RECOVERY.md).

## Magpie updates

Magpie application updates do not replace this plugin's bundled runtime, but host hooks, gateway translation and session handling can change its behavior. See [HOST_COMPATIBILITY.md](HOST_COMPATIBILITY.md) for the verified upstream commit, daily compatibility checks, version pinning and rollback boundaries. Future-version compatibility is not guaranteed.

## Test and independently build

There is no lockfile in the initial snapshot. Dependencies are declared in `package.json` (`zod` is pinned); avoid executing dependency lifecycle scripts:

```sh
bun install --ignore-scripts
bun test
```

 To verify binaries against this release, run `shasum -a 256 -c SHA256SUMS` on macOS/Linux. For a **strict byte-for-byte comparator** of rebuilt binaries against the checked-in artifacts, using Go 1.27.1:

```sh
bash scripts/verify-source-binaries.sh
```

To build individual binaries using Go 1.27 or newer:

```sh
(cd runtime && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o ../bin/magpie-tui-runtime.linux-amd64 ./cmd/magpie-tui-runtime)
(cd runtime && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o ../bin/magpie-tui-mcp-helper.linux-amd64 ./cmd/magpie-tui-mcp-helper)
```

Repeat with `GOOS=darwin` and `GOARCH=arm64/amd64`, or `GOOS=linux GOARCH=arm64` for other supported targets. Cross-compiled binaries have not all been tested natively. **Important: the v0.1.0 GitHub Actions Ubuntu build produces different binary hashes from a macOS-hosted Go 1.27.1 build of identical source.** Therefore, the strict comparator above can fail on a different host even if the build is legitimate. Use the GitHub Actions log and released `SHA256SUMS` for release-artifact provenance and integrity; do not interpret a cross-host hash mismatch by itself as compromised source or claim bit-for-bit cross-host reproducibility. The exact cause of this toolchain/environment divergence has not yet been isolated.

## Provenance and maintenance

Initial source was developed as [magpie-community/plugins PR #107](https://github.com/magpie-community/plugins/pull/107), which the maintainer **closed without merging**. This independent repository is **not** a continuation of an official review or approval. We retain upstream and vendored license notices (`LICENSE`, `runtime/LICENSE.magpie`, `vendor/claude-bridge-magpie/LICENSE`) and provide release checksums.

Issues and security concerns: [GitHub Issues](https://github.com/Guuuu233/magpie-claude-tui-plugin/issues). This is an experimental third-party distribution without SLA, support commitments or official affiliation.
