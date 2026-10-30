# Claude–Codex MCP Bridge

让 Codex 通过 MCP 调用本机 Claude Code：Codex 发出任务，桥接器运行 `claude -p`，等待执行完成后返回结果和会话 ID，可继续同一会话。

当前实现默认通过 DeepSeek 的 Anthropic 兼容接口运行 Claude Code。

```text
Codex → MCP stdio → server.js → Claude Code → DeepSeek
Codex ← 执行结果、会话 ID、费用和轮次 ← Claude Code
```

## 安装

需要 Node.js（依赖要求至少 18，本次验证使用 24）、npm，以及已安装并完成配置的 Claude Code 和 Codex。

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

结果以 MCP 文本内容中的 JSON 返回，包含 `ok`、`exit_code`、`session_id`、`result_text`、`total_cost_usd`、`num_turns` 和 `native_transcript_path`；错误时会返回错误说明，部分错误包含输出尾部。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 传给 Claude Code 子进程的 `ANTHROPIC_API_KEY` |
| `CLAUDE_BRIDGE_BASE_URL` | 默认 `https://api.deepseek.com/anthropic` |
| `CLAUDE_BRIDGE_CLAUDE_BIN` | Claude Code 可执行文件路径；启动示例默认 `claude` |
| `CLAUDE_BRIDGE_PROJECT_DIR` | 默认任务目录；启动示例默认当前工作目录 |

## 当前实现说明

- 本仓库保留现有桥接器行为。直接运行 `server.js` 时仍有 Windows 专用默认值（`claude.cmd` 和 `D:\CCCowork`），其他环境应明确配置上述变量或使用启动示例。Windows 启动尚未在本次上传中验证。
- `native_transcript_path` 是按 Windows 风格拼接的推测路径，在 Linux/macOS 上不能当作有效路径使用；实际记录由 Claude Code 自己管理。
- 服务器内置了委派、检查工作区和 Git 提交等工作流提示，请在接入前查看 `server.js` 中的 `INSTRUCTIONS`，确认符合自己的使用方式。
- Claude Code 可以在指定目录编辑文件和运行命令，实际行为受传入的权限模式及其自身配置影响。
- 本机专用的 `start-bridge.sh`、`node_modules`、密钥及会话文件不纳入仓库；通用启动示例不含密钥。

## 本地检查

```bash
node --check server.js
bash -n start-bridge.example.sh
```

上传前另已通过 MCP 客户端验证服务初始化与 `claude_run` 工具发现。本次检查没有调用真实 Claude Code，也没有验证模型端到端执行。
