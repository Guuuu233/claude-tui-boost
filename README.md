# Magpie Claude TUI 插件 / Claude TUI for Magpie

> **非官方第三方项目（experimental）**。并非 Anthropic、Magpie 或 `magpie-community/plugins` 官方认可的 Claude API 接入方式。通过 Claude 个人订阅供第三方工具调用可能不符合所适用的服务条款，存在封禁、额度和计费风险。**安装插件不会自动获得 Claude 账号或调用资格**，请自行核对当前条款；如需授权的 API 集成，请使用官方 API。

[中文使用说明](#中文使用说明) · [English installation & security guide](#english-installation--security-guide) · [首次连接](FIRST_CONNECT.md) · [恢复机制](RECOVERY.md) · [宿主兼容性](HOST_COMPATIBILITY.md) · [更新记录](CHANGELOG.md)

## 中文使用说明

### v0.2.7-rc.3 独立插件候选（未发布）

外部 systemd 管理 Runtime 时，推荐在插件 `options` 中保留 `runtimeURL`，同时添加 `runtimePortFile`，例如 `"runtimePortFile": "/home/magpie/.config/magpie-tui-runtime-production/port"`。插件会在每次请求时读取仅服务用户可访问的端口文件，从而在 Runtime 重启改变端口后自动恢复，避免网关静态 URL 漂移导致的 502。该选项只允许本机回环端口，不允许指向其他主机；托管模式无需配置它。

当前候选将近期审计修复直接纳入**本插件及随包的 Go Runtime**，无需编辑或重新编译 Magpie 本体。包含客户端断线时保留原工具回调、跨请求取消隔离、默认由原生 Claude Code `/usage` 读取额度，以及随包提供的只读预检命令 `magpie-tui-doctor`。该版本尚未在真实 Claude Desktop 长会话上做生产验收，不应无条件替换正在工作的生产版本。

有显式外部 Runtime 配置的服务可在升级前运行：

```sh
magpie-tui-doctor --plugins /path/to/plugins.json --runtime-dir /path/to/runtime-state --service-uid 1001
```

其中 UID 应替换为实际运行 Magpie 的账号 UID。命令只检查本地配置和状态文件元数据，重点拦截重复启用的 `claude-tui` 插件、旧端口、错误文件所有者或权限；不会联网、修改配置或读取 OAuth。**托管模式使用自己的账号级运行时启动/就绪验证，外部 Runtime 预检命令不能代替该过程。**

在 Magpie v0.1.1268 中，宿主可能让两个同名插件的请求头相互覆盖；此问题不能由第三方插件完整消除。候选采用“只允许单一启用实例 + 错误签名直接拒绝”的安全策略，不包含任何 Magpie 核心补丁。当前候选的源码、测试与发布说明见 [RELEASE_NOTES.md](RELEASE_NOTES.md)。

### 这是什么，能做什么？

这是一个独立发布的 Magpie 插件（Provider ID：`claude-tui`），使用**官方 Claude Code 已登录的交互式 TUI**作为推理后端，而不是 Anthropic API。插件附带 Go Runtime、MCP Helper 和 Bun/tmux Wrapper，使 Magpie/OpenCode 的模型请求通过原生 CLI 处理，再把 MCP 工具调用交回调用方。

已实现的主要功能包括：流式输出、会话与账号隔离、模型路由、多个工具调用、工具结果续接、取消、图片输入（有条件支持）、工具等待保护，以及有严格限制的中断恢复。项目附带部分崩溃/超时回归测试；**不能因此认为任何桌面客户端、Magpie 或 Claude Code 版本都已经完整验收**。

典型部署（插件和原生 CLI 必须在**同一台运行 Magpie 插件的主机**上）：

```text
Magpie / OpenCode / 接入 Magpie 网关的客户端
                    │
                    ▼
          Magpie 插件 claude-tui
                    │ (本机 loopback 受保护调用)
                    ▼
          随插件打包的 Go Runtime
                    │ MCP Helper + tmux Wrapper
                    ▼
             官方 Claude Code TUI
                    │
                    ▼
                Anthropic
```

如果是“Mac 上的客户端 → 自己的 Magpie 网关 → VPS 插件”，需要**在 VPS 的 Magpie 环境安装配置插件和登录 CLI**；仅在 Mac 上装插件不会升级 VPS。客户端本身的更新、遥测或远程 UI 网络连接，也**不受此模型桥接插件的统一控制**。

### 安装与首次连接

前提：支持 GitHub 插件安装的 Magpie、macOS/Linux（arm64 或 amd64）、官方 Claude Code CLI **2.1.268 或更新版本**、可运行 Bun/tmux 的环境。**原生 Windows 未支持**。

```sh
magpie plugin add github:Guuuu233/magpie-claude-tui-plugin
magpie plugin login claude-tui
```

可以选择“**自动安装并登录 Claude**”：通过终端检查/安装依赖、建立专用的私有 Claude 配置目录，并引导官方 `claude auth login --claudeai` 登录；浏览器授权及可能出现的安装权限请求需要用户自己操作。也可以使用“连接已登录 Claude”高级模式，提供已有的专用配置目录及实际模型 ID。请避免直接使用日常主配置目录；首次连接和 SSH/VPS 场景见 [FIRST_CONNECT.md](FIRST_CONNECT.md)、[AI_REMOTE_SETUP.md](AI_REMOTE_SETUP.md)。

自动连接通常提供 `sonnet` / `opus` / `haiku` 三个 CLI 模型别名，**不代表插件已发现、验证或授予你的真实模型权益**。正式使用前建议在一个新会话中验证：普通回复、无害工具调用、工具结果继续、取消和会话隔离。

### 409、502、中断恢复：现在能做什么？

**安全优先原则：外部 `Edit`、`Write`、`Bash` 可能已经执行，却未把结果成功回传。收到 409/502 后不要无条件重试同一工具，也不要直接删除 checkpoint 或重放原始命令。**

- MCP 工具长任务：生成的插件 MCP 服务调用上限为 30 分钟；交互式回调等待最长 90 分钟、原生运行计时器 12 小时；一次性调用原有的 5 分钟等待规则不变。**这些不是保证任务必定完成的 SLA**。
- 动态历史内容：在 `main` 当前源码中，只有**严格匹配**的 token 余额提示可以在旧用户消息的独立文本块被删除时忽略；其他用户指令、工具参数和普通提醒依然严格校验。
- 受控只读恢复（v0.2.3）：`MAGPIE_CLAUDE_AUTO_READONLY_HISTORY_DRIFT=1` **默认关闭**。只有活跃的原始工具回调、完全匹配的会话与模型、安全设置、已标记 Dirty 的持久化 checkpoint 等条件全部满足，才允许终止失配进程并启动一次**禁用工具的只读恢复轮次**。不会重新执行已经完成的修改，也不能复活此前已死亡的 MCP 回调。
- Claude Desktop `/compact`（v0.2.4）：识别专用压缩请求，将用户/助手消息及历史工具调用、结果和图片写入独立 Claude Code CLI 会话；系统提示作为标注过的历史背景。摘要轮禁用工具，历史工具不会重新执行，原会话 checkpoint 不会被替换。摘要内容会经过已配置的 Claude Code 登录路径；隔离 transcript 会额外保存在该 Claude profile 的会话目录中，遵循 CLI 的会话保留行为。
- Claude 额度卡（v0.2.7-rc.1）：默认由所选 profile 对应的**原生 Claude Code CLI** 执行 `claude -p /usage`，不因发现 `.credentials.json` 中的 OAuth access token 而自行直连额度接口。旧的 HTTPS 额度读取仅在明确配置 `usageMode: "direct"` 时启用，两条路径有相互隔离的 60 秒缓存。额度读取失败返回错误，不伪造 0%；不会在失败时自动切换为直接 OAuth。托管账号始终按各自 profile 查询。
- 旧会话的定向迁移需要私有证书与人工核查，不会作为普通插件安装功能开放。更完整的机制、其他开关、限制及拒绝场景见 [RECOVERY.md](RECOVERY.md)。

**托管安装配置**：六个经过明确允许的恢复环境变量只能取 `0` 或 `1`，且要在**Magpie 宿主服务启动环境**中设置，再在空闲时重新加载插件。仅在本机 Desktop 或终端设置变量，不能改变另一台 VPS 上的 Magpie 进程。不要为了追求“无感恢复”而一次性启用全部开关。生产环境是否启用，以及测试通过与否，不能从 GitHub 源码默认值直接推断。

### 版本、更新与兼容性

- **v0.2.7-rc.1 是未公开发布的候选，须通过独立源码或经过验证的 `.tgz` 包安装。** 不要把本地候选误当成仓库已经发布的 `v0.2.7` 正式标签。没有用户批准，不对正在工作的 Magpie 及 VPS 进行升级。

- **v0.2.6 修正 Claude TUI 额度读取**，优先读取账号实际的 5 小时与 7 天额度窗口，并保留无文件凭据 profile 的本机 CLI 回退。发布 GitHub 版本不会自动升级 VPS 上已安装的副本；需要在运行 Magpie 的主机更新插件，再刷新额度页。
- **v0.2.4 修复 Claude Desktop `/compact` 将已结束的历史工具误当作待接续调用的问题**。在 Magpie 中更新插件，或明确安装 `magpie plugin add github:Guuuu233/magpie-claude-tui-plugin#v0.2.4`。其他 409/502 仍需按实际错误排查；固定旧版本的安装不会自动获得此修复。升级前应结束正在执行的工具、保留旧状态及回滚途径。
- 插件携带自己的 Runtime、Helper 和 Wrapper；升级 Magpie **不会自动替换这些文件**，却可能修改插件加载、模型 API 转换、会话标识、流式请求与登录流程，因此**不能承诺对所有未来 Magpie/Claude Code 版本兼容**。有按已验证版本、最新发布版、上游 `main` 执行的兼容检查，详见 [HOST_COMPATIBILITY.md](HOST_COMPATIBILITY.md)。
- 支持 macOS 与 Linux 的四种 CPU/OS 组合发布构建；交叉编译通过**不代表**四种平台全部经历真实 OAuth 与 GUI 测试。用户数据目录、订阅额度、历史会话和私人恢复凭证不会随 GitHub 安装包分发。

### 安全与审计

该插件会运行第三方程序，并可能配置独立 Claude 用户目录中的信任设置、`bypassPermissions` 和 tmux 自动交互；**仅在可信设备与隔离账号中使用**。请在安装前阅读下面的 [English security details](#exact-security-and-configuration-effects)、[RECOVERY.md](RECOVERY.md) 和源码。不要把 SSH 凭证、OAuth 配置、历史聊天 JSONL、工具日志、API Key 或运行时私有证书上传到 Issues。

---

## English installation & security guide

### Overview

**Independent, experimental, not approved or reviewed by Magpie, Anthropic or the `magpie-community/plugins` maintainers.**

This provider uses a locally installed, already signed-in Claude Code **interactive TUI** through a tmux-based wrapper. It routes requests from Magpie/OpenCode through that TUI and bridges the caller's tools via MCP. Provider ID: `claude-tui`. It is **not** an official Anthropic API client, and it does not distribute Claude Code or copy your OAuth token into another process's API key.

> **Account and policy warning.** Using a Claude consumer subscription through other tools may not be permitted for your plan or use case and may result in usage charges, access restrictions or account suspension. Having a signed-in Claude Code session does not itself authorize third-party API-style usage. Verify current Anthropic terms yourself; use the official API if your usage requires an authorized integration. This project makes no compliance guarantee.

### Installation (from GitHub, not the community registry)

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

### Exact security and configuration effects

**Read this before installing.** Installing from GitHub runs **third-party code** under your Magpie process account. The automatic flow starts the managed runtime after verified login; the advanced flow starts it on the first request and uses a local loopback listener, a private key file and a per-account state directory. There is **no npm postinstall script**, but its runtime actively starts processes and writes configuration:

- The automatic connection action may install Homebrew/tmux using the system package manager, opens a terminal, and creates a fresh private Claude profile under plugin-owned state. Claude performs OAuth and stores its credentials there; the plugin never copies the main profile. No dependency installer runs just from loading/installing the plugin.
- Its vendored `claude-bridge-magpie/src/preaccept.ts` **writes the selected Claude config directory's `.claude.json`**, pre-accepting project trust and MCP approvals for the runtime's work directory. It makes a `.claude-bridge-backup` on the first modification.
- Its vendored `hook-install.ts` **installs runtime hooks** in `.claude/settings.local.json` inside the generated work directory in the managed user-context path. Other CLI paths may write Claude's global `~/.claude/settings.json`. Inspect your actual environment before enabling them.
- The wrapper enables `bypassPermissions` and `skipDangerousModePermissionPrompt` in the runtime work directory for non-root sessions, and can **automatically accept startup dialogs and send keystrokes in tmux**. A Claude TUI started this way can run without its normal interactive confirmation prompts. **Do not select your main Claude profile; use a dedicated, isolated profile and machine account.**
- The CLI/MCP runtime returns tool calls to the calling Agent for execution. Commands or edits approved by that Agent may alter files accessible to the Agent. A request whose tool execution state is uncertain is intended to fail closed; this is experimental, not a guarantee.
- The four-platform precompiled Go Runtime and MCP Helper binaries are shipped in `bin/`. Their Go sources are in `runtime/`; review them or build them locally before trusting them. The wrapper is vendored TypeScript in `vendor/` and requires Bun. No built-in telemetry or background model calls are intentionally added, but inspect code before use.

**Do not share** Claude configuration, Magpie authentication files, runtime keys, session transcripts, or debug logs. Do not expose the loopback runtime or Magpie gateway to untrusted networks. Use a private machine/VPS, and do not run arbitrary downloaded plugins with production secrets without reviewing them.

### How it works and what remains unsupported

**Available since v0.2.3:** An exact generated token-budget reminder inside an old user message may be ignored during handoff when no other content changed. For other history drift, an opt-in, *tool-free* fallback (`MAGPIE_CLAUDE_AUTO_READONLY_HISTORY_DRIFT=1`) requires the exact live tool ID, correct account/model/safeguards, canonical thread and an existing Dirty checkpoint. This cannot revive dead callbacks, blindly replay an Edit/Write/Bash or guarantee that every 409 disappears. See [RECOVERY.md](RECOVERY.md); this opt-in flag is included in v0.2.3 and remains disabled by default.

**Available since v0.2.4:** Claude Desktop's dedicated `/compact` request is recognized and summarized in a separate native Claude Code CLI session. User/assistant turns and structured tool/image blocks are retained; a system prompt is included as labelled archival context. Historical tool calls remain transcript evidence; the summary request has no tools, so those calls are not re-executed. The original conversation checkpoint is not resumed or overwritten. The full source history, including tool content and images, is written to an additional JSONL session under the configured Claude profile and passes through that profile's Claude Code authentication path; it can remain under the CLI's normal session-retention behavior.

**In the unreleased v0.2.7-rc.1 candidate:** Quota cards use the native `claude -p /usage` command by default even when the profile includes file-backed OAuth credentials. The former direct endpoint reader is available only with explicit `usageMode: "direct"` in an adapter configuration, with a separate 60-second cache; it never silently falls back to OAuth when native reading fails. Neither mode sends prompts or transcripts as part of usage reporting. Native CLI parsing failures are reported as errors, never fabricated zero utilization. This change is **not** present in the already published v0.2.6 package.

The bridge keeps a Claude Code process alive across turns and translates MCP `tool_use`/`tool_result` between Claude and the calling Agent. It supports streaming, cancellation, parallel tools and read-only recovery of certain interrupted conversations. Because the Desktop and CLI can reshape historic messages, some tool handoffs can still return HTTP 409 rather than risk executing a tool twice. Never blindly repeat `Edit`, `Write` or shell commands after an interrupted turn; check actual files first.

Current user-message images are supported; historic image replay is not. macOS arm64 and Linux amd64 have received limited local/remote runtime checks; macOS amd64 and Linux arm64 builds are cross-compiled only. Windows-native PTY execution is not supported. See [COMPATIBILITY.md](COMPATIBILITY.md). Experimental crash recovery and strict legacy-migration gates are described in [RECOVERY.md](RECOVERY.md).

### Magpie updates

Magpie application updates do not replace this plugin's bundled runtime, but host hooks, gateway translation and session handling can change its behavior. See [HOST_COMPATIBILITY.md](HOST_COMPATIBILITY.md) for the verified upstream commit, daily compatibility checks, version pinning and rollback boundaries. Future-version compatibility is not guaranteed.

### Test and independently build

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

### Provenance and maintenance

Initial source was developed as [magpie-community/plugins PR #107](https://github.com/magpie-community/plugins/pull/107), which the maintainer **closed without merging**. This independent repository is **not** a continuation of an official review or approval. We retain upstream and vendored license notices (`LICENSE`, `runtime/LICENSE.magpie`, `vendor/claude-bridge-magpie/LICENSE`) and provide release checksums.

Issues and security concerns: [GitHub Issues](https://github.com/Guuuu233/magpie-claude-tui-plugin/issues). This is an experimental third-party distribution without SLA, support commitments or official affiliation.
