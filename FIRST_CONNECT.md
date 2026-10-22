# 首次安装与连接

适用：macOS 或 Linux；已经安装官方 Claude Code 2.1.268 或更新版本。

## 正常操作

在 Magpie「插件 → 发现 → GitHub 非官方插件」中找到 **Guuuu233/claude-tui-boost** 并安装，或手动添加 `github:Guuuu233/claude-tui-boost`（不要加 `#标签`，否则收不到更新）。随后打开供应商 **Claude TUI** 的连接入口，选择 **自动安装并登录 Claude（推荐）**。插件安装本身不会运行系统安装脚本。

安装终端会自动打开。已有 tmux 时直接进入登录；缺少时通过系统包管理器安装。Mac 未装 Homebrew 时先运行 [Homebrew 官方安装器](https://brew.sh/)，其确认步骤和管理员密码提示保留；Linux 支持 apt-get、dnf、pacman，普通用户通过 sudo 输入密码。系统权限、网络连接和包管理器是否支持当前系统仍是实际前提。

Claude Code 随后运行官方 `claude auth login --claudeai`。在浏览器完成 Claude 订阅授权；需要手动粘贴授权码时，请粘贴到安装终端，不是聊天窗口。插件使用新建的独立配置目录，不读取或复制主账号凭证。

授权结束后，插件以 `claude auth status --json` 核对专用配置目录及订阅登录，再验证随包 Runtime 的启动握手。只有两项都成功才保存连接。无需输入配置路径、端口、密钥或版本化模型 ID。模型列表提供 `sonnet`、`opus`、`haiku` 官方别名；不表示当前账号对全部模型都有权限。

## VPS、SSH 与 AI 协助登录

在 VPS 的 Magpie 发起「自动安装并登录 Claude」后，界面会给出远程安装命令。请让 AI 在 **VPS 上、运行 Magpie 的同一个系统用户下**执行它。需要安装 tmux 或输入 sudo 密码时使用 `ssh -tt`；安装权限仍由系统处理。

依赖准备好后，登录进入插件自己的私有 tmux，会创建真正的终端。命令输出 JSON 状态；出现 `authorizationURL` 后，AI 将完整链接转交用户，在用户自己的浏览器中授权。兼容 `claude.ai/oauth/authorize` 和 `claude.com/cai/oauth/authorize` 等受限官方地址，localhost 回调地址不会当作授权链接转发。

浏览器如果显示授权码，可以直接粘贴到仍在运行的 SSH 命令；也可以让 AI 使用输出的 `commands.code`，将授权码从标准输入传入。不要把码拼进命令参数、脚本或报告。提交后显示等待验证，不要重复发送。仅打开网页不代表完成登录，`authenticated` 也只表示 Claude 登录已验证；Magpie 仍需完成自己的 Runtime 启动检查。

SSH 断开后，**已进入 tmux 的登录阶段**可在剩余有效期内继续。重新执行原命令会查看同一次登录，不会创建第二个 OAuth 进程。输出还会给出可直接执行的 `status`、`code`、`attach` 和 `cancel` 命令；`attach` 用来查看官方 CLI 的额外提示。自动化工具不方便保持长连接时，可把原命令最后的 `start` 换为 `start-detached`，启动后通过 `status` 查询。

依赖安装阶段仍需要正常 SSH 终端；如果此阶段中断，插件会拒绝盲目重复安装，并提示先核对依赖、必要时在 Magpie 重新连接。登录超时、进程异常退出或取消后，旧授权码不能继续用；重新从 Magpie 发起新连接即可。所有控制只针对该次连接的私有 tmux，不使用默认 tmux 服务，也不开放公网登录端口。

给 AI 的完整操作约束见 [AI_REMOTE_SETUP.md](AI_REMOTE_SETUP.md)。

## 权限与异常

- macOS 可能要求允许 Magpie 控制 Terminal。没有自动打开终端时，Magpie 会显示可复制执行的完整命令。
- Linux 桌面尝试系统默认终端、GNOME Terminal、Konsole、XFCE Terminal 或 xterm。SSH、容器和无桌面的服务器需在运行 Magpie 的同一台机器执行所显示的命令，不能在另一台电脑执行。
- 要取消实际安装或登录，请在安装终端按 **Ctrl+C**；SSH 后台登录还可执行输出的 `cancel` 命令。Magpie 宿主的登录取消接口目前不会向插件转发取消信号，因此仅关闭 Magpie 的登录面板不等于终止终端任务。
- 安装流程有九分钟上限，低于已核对宿主的十分钟登录等待上限。网络或系统依赖准备过慢时会失败；可完成依赖安装后重新连接，不需要删除原账号。
- 已存在的 Claude 连接仍可使用「连接已登录 Claude」。新自动流程每次建立独立配置；不同账号不会共用默认目录。卸载插件不自动删除授权目录；如需清理，请先确认不用该账号，再管理相应专用目录。
- 不支持原生 Windows。安装到本地不会修改 VPS 上的生产实例。

## 验证范围

自动化测试使用假 Claude/包管理器及私有临时 HOME，覆盖真实安装助手进程、登录状态核对、失败/取消、路径处理、真实打包 Runtime 启动和 Magpie 宿主 RPC。SSH 改进额外使用真实的私有 tmux 和假 Claude，模拟终端挂断、重连、授权码回传、过期与不同账号隔离；没有在真实 VPS 上发起 OAuth。真实账号浏览器 OAuth、macOS Terminal 的系统授权弹窗及各 Linux 桌面尚未逐一实机验收，不能把这些隔离测试说成全平台真实登录验证。

官方命令参考：[Claude Code CLI](https://code.claude.com/docs/en/cli-reference)、[模型别名](https://code.claude.com/docs/en/model-config)。
