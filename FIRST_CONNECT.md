# 首次安装与连接

适用：macOS 或 Linux；已经安装官方 Claude Code 2.1.268 或更新版本。

## 正常操作

在 Magpie「插件 → 发现」安装 `magpie-claude-tui-plugin`。随后打开供应商 **Claude TUI** 的连接入口，选择 **自动安装并登录 Claude（推荐）**。插件安装本身不会运行系统安装脚本。

安装终端会自动打开。已有 tmux 时直接进入登录；缺少时通过系统包管理器安装。Mac 未装 Homebrew 时先运行 [Homebrew 官方安装器](https://brew.sh/)，其确认步骤和管理员密码提示保留；Linux 支持 apt-get、dnf、pacman，普通用户通过 sudo 输入密码。系统权限、网络连接和包管理器是否支持当前系统仍是实际前提。

Claude Code 随后运行官方 `claude auth login --claudeai`。在浏览器完成 Claude 订阅授权；需要手动粘贴授权码时，请粘贴到安装终端，不是聊天窗口。插件使用新建的独立配置目录，不读取或复制主账号凭证。

授权结束后，插件以 `claude auth status --json` 核对专用配置目录及订阅登录，再验证随包 Runtime 的启动握手。只有两项都成功才保存连接。无需输入配置路径、端口、密钥或版本化模型 ID。模型列表提供 `sonnet`、`opus`、`haiku` 官方别名；不表示当前账号对全部模型都有权限。

## 权限与异常

- macOS 可能要求允许 Magpie 控制 Terminal。没有自动打开终端时，Magpie 会显示可复制执行的完整命令。
- Linux 桌面尝试系统默认终端、GNOME Terminal、Konsole、XFCE Terminal 或 xterm。SSH、容器和无桌面的服务器需在运行 Magpie 的同一台机器执行所显示的命令，不能在另一台电脑执行。
- 要取消实际安装或登录，请在安装终端按 **Ctrl+C**。Magpie 宿主的登录取消接口目前不会向插件转发取消信号，因此仅关闭 Magpie 的登录面板不等于终止终端任务。
- 安装流程有九分钟上限，低于已核对宿主的十分钟登录等待上限。网络或系统依赖准备过慢时会失败；可完成依赖安装后重新连接，不需要删除原账号。
- 已存在的 Claude 连接仍可使用「连接已登录 Claude」。新自动流程每次建立独立配置；不同账号不会共用默认目录。卸载插件不自动删除授权目录；如需清理，请先确认不用该账号，再管理相应专用目录。
- 不支持原生 Windows。安装到本地不会修改 VPS 上的生产实例。

## 验证范围

自动化测试使用假 Claude/包管理器及私有临时 HOME，覆盖真实安装助手进程、登录状态核对、失败/取消、路径处理、真实打包 Runtime 启动和 Magpie 宿主 RPC。真实账号浏览器 OAuth、macOS Terminal 的系统授权弹窗及各 Linux 桌面尚未逐一实机验收，不能把这些隔离测试说成全平台真实登录验证。

官方命令参考：[Claude Code CLI](https://code.claude.com/docs/en/cli-reference)、[模型别名](https://code.claude.com/docs/en/model-config)。
