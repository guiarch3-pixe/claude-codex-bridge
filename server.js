import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Config (override via env vars in .codex/config.toml's [mcp_servers.*.env])
// ---------------------------------------------------------------------------
const DEFAULT_PROJECT_DIR = process.env.CLAUDE_BRIDGE_PROJECT_DIR || "D:\\CCCowork";
const CLAUDE_BIN = process.env.CLAUDE_BRIDGE_CLAUDE_BIN || "claude.cmd";
const DEEPSEEK_BASE_URL = process.env.CLAUDE_BRIDGE_BASE_URL || "https://api.deepseek.com/anthropic";

// ---------------------------------------------------------------------------
// Best-effort mirror of Claude Code's own project-path encoding, used only to
// tell the caller where the *native* session transcript should end up
// (Claude Code writes this itself — we are not creating or maintaining it).
//
// VERIFY ON YOUR MACHINE: run one real task, then look at what folder name
// actually appears under %USERPROFILE%\.claude\projects\ and compare. The
// colon after a Windows drive letter (D:) is the most likely mismatch — this
// function guesses it also becomes a hyphen, but that's unconfirmed.
// ---------------------------------------------------------------------------
function encodeProjectPath(cwd) {
  return cwd.replace(/[\\/:_]/g, "-");
}

function nativeTranscriptPath(cwd, sessionId) {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (!home || !sessionId) return null;
  return `${home}\\.claude\\projects\\${encodeProjectPath(cwd)}\\${sessionId}.jsonl`;
}

// ---------------------------------------------------------------------------
// Spawn headless Claude Code, wait for it to exit, parse its JSON result.
// ---------------------------------------------------------------------------
function runClaudeCode(prompt, opts = {}) {
  return new Promise((resolve) => {
    const cwd = opts.cwd || DEFAULT_PROJECT_DIR;

    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--permission-mode", opts.permission_mode || "acceptEdits",
    ];
    if (opts.allowed_tools) args.push("--allowedTools", opts.allowed_tools);
    if (opts.resume_session_id) args.push("--resume", opts.resume_session_id);
    if (opts.max_turns) args.push("--max-turns", String(opts.max_turns));

    let child;
    try {
      child = spawn(CLAUDE_BIN, args, {
        cwd,
        windowsHide: true,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: DEEPSEEK_BASE_URL,
          ANTHROPIC_API_KEY: process.env.DEEPSEEK_API_KEY,
        },
      });
    } catch (err) {
      resolve({ ok: false, error: `Failed to spawn Claude Code: ${err.message}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    const timeoutMs = (opts.timeout_sec || 1800) * 1000;
    let timedOut = false;
    const hardTimeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(hardTimeout);
      resolve({ ok: false, error: `Failed to run Claude Code: ${err.message}` });
    });

    child.on("close", (exitCode) => {
      clearTimeout(hardTimeout);

      if (timedOut) {
        resolve({
          ok: false,
          error: `Claude Code exceeded the ${opts.timeout_sec || 1800}s timeout and was killed.`,
          stdout_tail: stdout.slice(-2000),
          stderr_tail: stderr.slice(-2000),
        });
        return;
      }

      let parsed = null;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        // stdout wasn't valid JSON — surface raw output instead of pretending
      }

      if (!parsed) {
        resolve({
          ok: false,
          exit_code: exitCode,
          error: "Could not parse Claude Code output as JSON — see stdout_tail/stderr_tail.",
          stdout_tail: stdout.slice(-2000),
          stderr_tail: stderr.slice(-2000),
        });
        return;
      }

      resolve({
        ok: exitCode === 0 && !parsed.is_error,
        exit_code: exitCode,
        session_id: parsed.session_id ?? null,
        result_text: parsed.result ?? null,
        total_cost_usd: parsed.total_cost_usd ?? null,
        num_turns: parsed.num_turns ?? null,
        native_transcript_path: nativeTranscriptPath(cwd, parsed.session_id),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// The playbook. Codex reads this once at connection time — it's the place to
// encode "when to delegate / how to review / git discipline / when to
// interrupt the user" so you don't have to repeat it in every conversation.
// ---------------------------------------------------------------------------
const INSTRUCTIONS = `
This server bridges to Claude Code (headless, DeepSeek-backed) for this
project. Use it as follows:

- Delegate vs. do it yourself: use claude_run for substantial work (new
  features, multi-file changes, anything needing iterative test-and-fix).
  For small, obviously-scoped edits (single file, a config tweak, read-only
  analysis) just do it directly yourself — don't delegate trivial work.

- Before the first claude_run call for a fresh task, check whether the git
  working tree is clean (git status --porcelain). If it is not, stop and
  ask the user how to proceed instead of running Claude Code against a
  dirty tree.

- Never trust result_text alone. After each call, verify the change
  yourself (git diff, run the project's tests/build) before deciding
  whether it meets the request.

- If it doesn't meet the request, call claude_run again with the same
  resume_session_id and a specific description of what's wrong. Cap this
  at around 4 rounds total; if still unresolved, stop and report the
  situation to the user instead of continuing to retry.

- Once satisfied, make a single local git commit summarizing the change
  (include the returned session_id in the commit body, so the native
  Claude Code transcript can be found later via
  ~/.claude/projects/<encoded-cwd>/<session_id>.jsonl). Never push to a
  remote automatically — that stays a manual, human decision.

- Only interrupt the user when the task is fully done, or when you're
  stuck. Don't report progress after every intermediate round.
`.trim();

// ---------------------------------------------------------------------------
// Server + tool registration
// ---------------------------------------------------------------------------
const server = new McpServer(
  { name: "claude-code-bridge", version: "0.1.0" },
  { instructions: INSTRUCTIONS }
);

server.tool(
  "claude_run",
  "Run Claude Code (headless, DeepSeek-backed) to write/edit code and run commands in the project. Blocks until Claude Code finishes and returns its result.",
  {
    prompt: z.string()
      .describe("Instructions for Claude Code: the initial task, or specific feedback when continuing via resume_session_id."),
    cwd: z.string().optional()
      .describe(`Working directory. Defaults to ${DEFAULT_PROJECT_DIR}.`),
    permission_mode: z.string().optional()
      .describe("Claude Code --permission-mode. Defaults to 'acceptEdits'."),
    allowed_tools: z.string().optional()
      .describe("Claude Code --allowedTools, e.g. 'Read,Edit,Bash(npm test)'."),
    resume_session_id: z.string().optional()
      .describe("session_id from a prior claude_run call, to continue that conversation with feedback."),
    max_turns: z.number().optional()
      .describe("Claude Code --max-turns."),
    timeout_sec: z.number().optional()
      .describe("Hard timeout in seconds before the process is killed. Defaults to 1800."),
  },
  async (args) => {
    const result = await runClaudeCode(args.prompt, args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

await server.connect(new StdioServerTransport());
