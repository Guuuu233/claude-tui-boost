# AI 协助 VPS 登录的操作约束

用于用户本机的 AI，通过 SSH 配置远程 Magpie。用户需要亲自在本机浏览器授权；AI 不处理账号密码，不导出 Claude 凭证。

1. 在目标 VPS、运行 Magpie 的同一系统用户下操作。让用户从 Claude TUI 供应商发起「自动安装并登录 Claude」，取得本次界面生成的完整命令；不要猜测其他用户的配置路径。
2. 依赖安装阶段需要交互式权限提示时使用 `ssh -tt`。系统密码由用户在正常终端提示中输入，不写进命令。已经具备 tmux 时，登录助手会自行创建私有 PTY；工具不便长时间等待时可用原命令的 `start-detached` 动作。
3. 阅读命令输出的 JSON。看到 `authorizationURL` 后，把完整官方授权链接作为可点击链接交给用户；保留所有查询参数，不改写域名，不转发为短链接，不打开 localhost 回调地址，不把链接公开到 Issue 或日志报告。
4. 等用户完成官方浏览器授权。如果网页给出授权码，优先由用户粘贴到 SSH 安装终端。确需 AI 代传时，用输出的 `commands.code` 从标准输入发送单行授权码；不要把码放在 argv、shell 字面量、环境变量、脚本文件或会话总结中。不要读取或打印 `.credentials.json`、Keychain、访问令牌或刷新令牌。
5. `code_submitted` 或 `verifying_authorization` 表示等待核验，不能再次提交同一个码。不要仅凭浏览器授权页、`Login successful` 或进程退出码宣布完成；`authenticated` 只确认专用目录的 Claude 登录，最终还应看到 Magpie 完成连接。
6. SSH 断线后重新运行同一安装命令，或执行原输出的 `commands.status`。它们沿用同一登录进程。需要查看官方 CLI 特殊提示时用 `commands.attach`，不要绕过助手启动第二个 `claude auth login`。
7. 登录失败、超时或进程中断时，记录失败阶段和脱敏错误，让用户在 Magpie 重新发起连接。不要重放旧授权码，不清空原有 Claude 配置或 Magpie checkpoint，不改已有账号。依赖安装中断时先核对实际安装状态。
8. 用户取消时，使用 `commands.cancel` 或安装终端 Ctrl+C。不要运行 `pkill claude`、`tmux kill-server` 等针对整个用户环境的清理；助手只管理自己的私有服务。关闭 Magpie 登录面板本身不会向插件传递取消信号。

官方参考：[Claude Code 身份验证](https://code.claude.com/docs/en/authentication)。当前插件不假设 `claude auth login` 存在 `--no-browser` 参数，也不自动建立公网回调代理或 SSH 端口转发。
