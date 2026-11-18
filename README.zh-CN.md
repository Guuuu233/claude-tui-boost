<div align="center">

[English](./README.md) · **简体中文**

# Claude TUI Boost

### 让 Claude 订阅额度更耐用

**通过真实 Claude Code 交互式 TUI 接入 Magpie/OpenCode，让 Agent 复用会话、稳定衔接 MCP 工具调用。**  
持续会话、流式响应、MCP 工具往返——无需修改 Magpie 本体。

[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![上游版本](https://img.shields.io/github/v/release/Guuuu233/claude-tui-boost)](https://github.com/Guuuu233/claude-tui-boost/releases/latest)
[![macOS / Linux / Windows WSL2](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows%20(WSL2)-lightgrey)](COMPATIBILITY.md)

</div>

## 为什么值得试试？

在一组 **Claude Pro + Opus 5.5** 对照测试中，相同 API 等价工作量下，**交互式 TUI 路径比受测的 `claude -p` 非交互路径少消耗约 44%～50% 的 5 小时额度**，相当于在该负载下 **约 1.8～2 倍的额度使用效率**。[查看实测与讨论 →](https://github.com/yetone/magpie/pull/707)

这是特定负载下的历史结果，并非所有模型、账号和任务都能复现；**插件不会增加订阅的官方额度上限，也不保证节省比例**。会话连续性与缓存命中同样会影响差异。

| 对比 | 对照测试中的非交互式调用 | 接入本插件后 |
| :-- | :-- | :-- |
| **执行方式** | 每轮新建 `claude -p` 进程 | tmux/PTY 驱动真实 Claude Code TUI，支持原生会话续接 |
| **接入方式** | 直接使用 print 模式 | 通过 Magpie 兼容端点路由至 `claude-tui` Provider |
| **工具交互** | 单次非交互请求周期 | MCP 工具调用与结果交还上层 Agent |
| **额度表现** | 对照基线 | **上述单组测试中减少 44%～50% 消耗** |

### 主要能力

- **多轮连续会话**：让同一 Agent 会话尽量沿用 Claude Code 原生会话，减少反复启动和上下文重建。
- **真正的 Agent 工具交互**：支持流式输出、并行 MCP 工具调用与结果续接、取消和受约束的中断恢复。
- **查看订阅额度**：默认通过对应账号的原生 Claude Code `/usage` 读取 5 小时与 7 天用量。
- **独立插件安装**：自带 Go Runtime、MCP Helper 与 tmux Wrapper，不需要给 Magpie 本体打补丁。

```text
兼容 Magpie 的 Agent / SDK 客户端
                 │
                 ▼
             Magpie 网关
                 │
                 ▼
        Claude TUI Provider
                 │
                 ▼
       Go Runtime + MCP / tmux
                 │
                 ▼
         原生 Claude Code TUI
```

## Fork 安装：0.2.20-fork.2

本 fork 随包提供 Linux/macOS、amd64/arm64 四种目标的 Runtime 与 MCP Helper。`0.2.20-fork.2` 更新托管 Runtime 的 JavaScript 生命周期，沿用 `0.2.20-fork.1` 的八个可执行产物；历史导入和 Linux 僵尸进程识别继续保留，本轮 Go 构建次数为零。

```sh
magpie plugin add github:liangxyz/claude-tui-boost
```

网页安装或更新入口填写 `github:liangxyz/claude-tui-boost`，完成后确认版本为 `0.2.20-fork.2`。在 Magpie 服务环境保留 `MAGPIE_CLAUDE_HISTORY_IMPORT=1` 可启用归档式历史重建；已验证的续接保留原生会话身份与历史匹配，当前输入超出预算时沿同一私有分页通道传入，原resume ID继续保留。512 KiB 以内的导入继续直接传入；超出时改用短首轮提示和当前回合专属的 MCP 分页读取，完整归档包含历史与当前任务，超大的当前输入也沿此路径保留。内联图片沿已有私有 MCP 通道读取。分页会增加工具调用和等待，模型上下文容量仍适用，具体行为见 [恢复说明](RECOVERY.md)。

相同已保存账号、相同规范配置目录来源的多个插件宿主可共享一个经认证的托管 Runtime。每个宿主独立持有连接，旧宿主退出仅释放自身连接，最后一个认证客户端离开后再收尾；会话继续沿原生边界隔离。各宿主请使用相同目录拼写。owner 自动重启、端点迁移与跨别名附着留待独立需求。Node/Bun 隔离夹具、13 项既有定点用例及真实平台覆盖范围见 [发布说明](RELEASE_NOTES.md)。

首次从旧独占 supervisor 升级时，请待活跃任务结束，在空闲边界更新并完成旧宿主退出，再启动共享路径。原 claim、账号目录、Claude profile、登录资料及会话状态保留；两份托管 JavaScript 需配套更新，现有 Runtime 可继续使用。

Docker 部署保持现有 `/config` 挂载；重建容器时可启用 Compose 的 `init: true` 或 Docker 的 `--init`，用于回收孤儿进程。历史本机构建的 `bin/magpie-tui-runtime` 具有优先级；正常托管入口使用随包的平台专用 Runtime。

`package-assets.json` 记录版本、Go 工具链、文件种类、平台/架构与字节数。打包检查覆盖清单完整性、普通可执行文件及平台文件头；Linux 启动行为另行实测。该 fork 采用零内容摘要操作的打包约定。macOS 与 arm64 产物为交叉构建，相应真实平台运行效果留待目标环境验证。

## 上游 v0.2.18 安装参考

**环境要求：** 支持 GitHub 插件安装的 Magpie、官方 Claude Code CLI **2.1.268 或更新版本**，系统为 macOS、Linux（arm64、x64）或启用了 WSL2 的 Windows（默认 WSL2 发行版内需有 `bun`、`tmux` 与 `claude`）。连接向导可以自动准备 tmux；在 Windows 上，插件通过 `wsl.exe` 自动桥接进 WSL2 运行。**插件和 Claude Code 必须安装在运行 Magpie 的同一台主机**，VPS 用户应在 VPS 上操作。

**第 1 步：安装上游版本**（上游参考版 [v0.2.18](https://github.com/Guuuu233/claude-tui-boost/releases/tag/v0.2.18)）。

```sh
magpie plugin add github:Guuuu233/claude-tui-boost
magpie plugin login claude-tui
```

主分支始终保持为最新正式版，有新版本时 Magpie 的 **插件** 页会提示更新（也可运行 `magpie plugin update`）。不要加 `#标签`：标签不会移动，Magpie 就永远不会提示更新。更新会重启插件宿主，托管 runtime 随之重启，请在任务间隙更新。以前用 `#v0.2.x` 安装的，运行一次上面的命令即可切换。

**第 2 步：连接 Claude。** 在 Magpie 的 **Claude TUI** 供应商页面选择「**自动安装并登录 Claude**」，按提示通过官方浏览器页面完成授权。向导会创建独立 Claude 配置目录；已有专用登录目录也可选择高级连接方式。

**第 3 步：在 Agent 中选择模型。** 让客户端通过 Magpie 网关调用新供应商，再选用 `sonnet`、`opus`、`haiku` 等 CLI 别名，先做一次普通对话和无害工具调用测试。模型别名并不意味着账号拥有对应权限。

**接入范围：** 插件**不会自动劫持**你在终端直接运行的 `claude -p`，也不会自动改写未配置的 Claude Agent SDK。客户端必须显式接入 Magpie 兼容端点。首次连接与 VPS 操作详见 [首次连接](FIRST_CONNECT.md)、[远程安装](AI_REMOTE_SETUP.md)。

> **安装前须知：** 这是**非官方实验性第三方插件**。通过其他 Agent 使用个人 Claude 订阅可能不符合相关服务条款，存在账号受限风险；[相关上游方案未被接受](https://github.com/yetone/magpie/pull/707)。插件还可能以减少权限确认的方式启动 Claude，请仅在可信环境中使用专用配置与隔离账号。具体影响见 [安全与技术说明](TECHNICAL_REFERENCE.md#exact-security-and-configuration-effects)、[恢复边界](RECOVERY.md)。需要正式授权的 SDK/API 集成时，应选择 Anthropic 官方 API。

## 文档导航

| 文档 | 内容 |
| :-- | :-- |
| [首次连接](FIRST_CONNECT.md) · [VPS / SSH 安装](AI_REMOTE_SETUP.md) | 安装、登录、浏览器授权与远程配置 |
| [兼容性](COMPATIBILITY.md) · [Magpie 宿主兼容性](HOST_COMPATIBILITY.md) | 支持平台、已测范围与升级注意事项 |
| [中断恢复](RECOVERY.md) | 409/502、工具安全与可选恢复开关 |
| [完整技术说明](TECHNICAL_REFERENCE.md) | 高级参数、权限影响、测试和源码构建 |
| [版本说明](RELEASE_NOTES.md) · [更新记录](CHANGELOG.md) | 已实现改进、已知限制和后续维护 |

**上游版本参考：** `v0.2.18` 在 lite 恢复路径上校验完整前缀哈希（避免客户端改写早先消息后仍按旧原生会话恢复），并在旧 run 异步退出时保留新接管 run 的 `liveOuter` 槽位（#27、#28）。`v0.2.17` 为重建会话增加 1 小时缓存断点、支持宿主机重启后自动回收残留 `.managed-live` 锁、并兼容 `nologin` 服务账户启动 tmux（#21、#22、#23）。`v0.2.16` 在 `package.json` 的 `os` 字段加入 `win32`（避免 Windows 下安装被包管理器拦截）并同步更新全部技术说明文档（`v0.2.15` 新增 Windows WSL2 自动桥接支持）。`v0.2.14` 把请求上限从 16 MiB 提高到 32 MiB（图片很多的长对话不再中断），超过上限时返回 413，而不是会被反复重试的 502。`v0.2.13` 在 v0.2.12 基础上收紧已完成工具回复的回放：只有完全相同的请求才会拿到旧回复；额度用尽时返回 429 而非 502；复杂长会话与工具重放边界仍属实验性能力，详见[发布说明](RELEASE_NOTES.md)。

## 参与贡献

欢迎在 [Issues](https://github.com/Guuuu233/claude-tui-boost/issues) 反馈问题、通过 [Pull Requests](https://github.com/Guuuu233/claude-tui-boost/pulls) 提交改进；反馈前请删除个人凭证和私有会话内容。如果项目对你有用，也欢迎点个 ⭐ Star。
