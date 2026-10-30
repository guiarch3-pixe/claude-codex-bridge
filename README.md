# Claude–Codex MCP Bridge

让 Codex 通过 MCP 调用本机 Claude Code：Codex 发出任务，桥接器运行 `claude -p`，等待执行完成后返回结果和会话 ID，可继续同一会话。

默认通过 DeepSeek 的 Anthropic 兼容接口运行 Claude Code；`CLAUDE_BRIDGE_BASE_URL` 可指向其他兼容端点。

```text
Codex → MCP stdio → server.js → Claude Code → DeepSeek
Codex ← 执行结果、会话 ID、费用和轮次 ← Claude Code
```

## 安装

需要 Node.js 18+、npm，以及已安装并完成配置的 Claude Code 和 Codex。Linux/macOS 已验证；Windows 使用 `.cmd` 包装器时需要确认 Codex 的启动环境能直接执行它。

```bash
git clone https://github.com/guiarch3-pixe/claude-codex-bridge.git
cd claude-codex-bridge
npm ci
```

## 配置（Linux / macOS）

将 DeepSeek API key 设置为启动 Codex 时可用的 `DEEPSEEK_API_KEY` 环境变量，或将密钥单独保存在 `${XDG_CONFIG_HOME:-$HOME/.config}/claude-codex-bridge/deepseek-api-key` 文件中，并限制该文件仅自己可读写。启动示例会优先使用环境变量，再读取该文件。

在 `~/.codex/config.toml` 添加以下内容，将所有示例绝对路径替换为自己的路径。如果已有 `claude_code` 配置，更新已有条目，避免重复表名。

```toml
[mcp_servers.claude_code]
command = "bash"
args = ["/absolute/path/to/claude-codex-bridge/start-bridge.example.sh"]
env_vars = ["DEEPSEEK_API_KEY"]
tool_timeout_sec = 1860

[mcp_servers.claude_code.env]
CLAUDE_BRIDGE_PROJECT_DIR = "/absolute/path/to/your/project"
CLAUDE_BRIDGE_CLAUDE_BIN = "/absolute/path/to/claude"
```

`bash`、`node` 必须能在 Codex 的启动环境中找到；使用 nvm 等工具时，请确认启动环境包含对应的 PATH。`command` 也可以使用 Bash 的绝对路径。

MCP 的配置字段见 [Codex 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。配置后重启 Codex，可通过 `codex mcp list` 检查注册情况。

Windows 上可直接让 `command` 指向 `node`、`args` 指向 `server.js`，并在 `[mcp_servers.claude_code.env]` 设置目录和可执行文件；`start-bridge.example.sh` 需要 Git Bash 运行。`DEEPSEEK_API_KEY` 建议由父进程环境变量传入。

## 工具

桥接器提供 `claude_run`：

| 参数 | 说明 |
| --- | --- |
| `prompt` | 必填，任务描述或续接会话时的反馈 |
| `cwd` | 本次任务工作目录，覆盖环境变量中的默认目录 |
| `permission_mode` | Claude Code 权限模式，默认 `acceptEdits` |
| `allowed_tools` | 传给 Claude Code 的工具列表 |
| `resume_session_id` | 继续此前返回的会话 ID |
| `max_turns` | 可选轮次限制；不传时桥接器不设置限制 |
| `timeout_sec` | 子进程超时秒数，默认 1800；增大时同步调整 MCP 工具超时 |

结果以 MCP 文本内容中的 JSON 返回，包含 `ok`、`exit_code`、`session_id`、`result_text`、`total_cost_usd`、`num_turns` 和 `native_transcript_path`（找不到转录文件时为 `null`）；错误时会返回错误说明，部分错误包含输出尾部。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 传给 Claude Code 子进程的 `ANTHROPIC_API_KEY` |
| `CLAUDE_BRIDGE_BASE_URL` | 默认 `https://api.deepseek.com/anthropic` |
| `CLAUDE_BRIDGE_CLAUDE_BIN` | Claude Code 可执行文件路径；默认 `claude`（Windows 为 `claude.cmd`） |
| `CLAUDE_BRIDGE_PROJECT_DIR` | 默认任务目录；默认 `process.cwd()` |

## 安全边界

- 桥接器只通过 stdio 与 MCP 客户端通信，不监听网络端口。只把它接到你信任的 Codex/MCP 客户端。
- Claude Code 会在 `cwd` 中读写文件并可能运行命令。默认权限模式是 `acceptEdits`；处理不可信仓库时，请降低权限、限制 `allowed_tools`，或放进容器/沙箱。
- `INSTRUCTIONS` 要求调用方在委派前检查工作区、执行后自行复核 diff，并且只做本地 commit、不自动 push。它是指令，不是强制隔离。
- 密钥只放在环境变量或权限为 `0600` 的 key 文件中；`start-bridge.sh`、密钥、会话文件和 `node_modules/` 都不在版本库里。

## 测试

```bash
npm test
```

测试使用一个假的 `claude` 可执行文件和一个 MCP 客户端，验证参数拼装、输出解析、超时、转录路径和 `claude_run` 的完整 stdio 往返；不需要 API key 或网络。

## 已知限制

- `native_transcript_path` 是尽力而为：先按 Claude Code 的项目目录编码猜测，再按 session id 搜索 `~/.claude/projects`；找不到时返回 `null`。转录文件由 Claude Code 自己维护。
- Windows 的 `.cmd` 启动未在自动化测试中验证；如遇 spawn 错误，请把 `CLAUDE_BRIDGE_CLAUDE_BIN` 指向可直接执行的文件。
- 测试不调用真实 Claude Code 或 DeepSeek，真实端到端执行需要你自己配置密钥后验证。
- 桥接器不做提示词注入防护、沙箱或权限提升；安全边界由 MCP 客户端、Claude Code 权限模式和运行环境共同决定。

## License

MIT
