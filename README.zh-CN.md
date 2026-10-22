<div align="center">

[English](./README.md) · **简体中文**

# Claude TUI Boost

### 让 Claude 订阅额度更耐用

**通过真实 Claude Code 交互式 TUI 接入 Magpie/OpenCode，让 Agent 复用会话、稳定衔接 MCP 工具调用。**  
持续会话、流式响应、MCP 工具往返——无需修改 Magpie 本体。

[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Release](https://img.shields.io/badge/release-v0.2.13-blue)](https://github.com/Guuuu233/claude-tui-boost/releases/tag/v0.2.13)
[![macOS / Linux](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](COMPATIBILITY.md)

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
- **查看订阅额度**：当前 v0.2.13 正式版默认通过对应账号的原生 Claude Code `/usage` 读取 5 小时与 7 天用量。
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

## 30 秒看懂如何安装

**环境要求：** 支持 GitHub 插件安装的 Magpie、官方 Claude Code CLI **2.1.268 或更新版本**，系统为 macOS / Linux（arm64、x64）。连接向导可以准备 tmux，Bun 由 Magpie 宿主提供；暂不支持原生 Windows。**插件和 Claude Code 必须安装在运行 Magpie 的同一台主机**，VPS 用户应在 VPS 上操作。

**第 1 步：安装 v0.2.13 正式版**（[v0.2.13](https://github.com/Guuuu233/claude-tui-boost/releases/tag/v0.2.13)）。

```sh
magpie plugin add github:Guuuu233/claude-tui-boost#v0.2.13
magpie plugin login claude-tui
```

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

**当前稳定版：** `v0.2.13` 在 v0.2.12 基础上收紧已完成工具回复的回放：只有完全相同的请求才会拿到旧回复；复杂长会话与工具重放边界仍属实验性能力，详见[发布说明](RELEASE_NOTES.md)。

## 参与贡献

欢迎在 [Issues](https://github.com/Guuuu233/claude-tui-boost/issues) 反馈问题、通过 [Pull Requests](https://github.com/Guuuu233/claude-tui-boost/pulls) 提交改进；反馈前请删除个人凭证和私有会话内容。如果项目对你有用，也欢迎点个 ⭐ Star。
