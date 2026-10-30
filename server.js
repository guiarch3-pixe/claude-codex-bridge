import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Config (override via env vars in Codex's [mcp_servers.*.env])
// ---------------------------------------------------------------------------
const DEFAULT_PROJECT_DIR = process.env.CLAUDE_BRIDGE_PROJECT_DIR || process.cwd();
const CLAUDE_BIN = process.env.CLAUDE_BRIDGE_CLAUDE_BIN
  || (process.platform === "win32" ? "claude.cmd" : "claude");
const DEEPSEEK_BASE_URL = process.env.CLAUDE_BRIDGE_BASE_URL || "https://api.deepseek.com/anthropic";

// ---------------------------------------------------------------------------
// Best-effort mirror of Claude Code's own project-path encoding, used only to
// tell the caller where the native session transcript should end up. Claude
// Code writes the transcript itself; the bridge never creates or edits it.
//
// The encoding has changed across Claude Code versions, so nativeTranscriptPath
// verifies the guessed path and also falls back to searching by session id.
// A wrong guess becomes null, never a misleading path.
// ---------------------------------------------------------------------------
export function encodeProjectPath(cwd) {
  return cwd.replace(/[\\/:_]/g, "-");
}

export function nativeTranscriptPath(cwd, sessionId, home = homedir()) {
  if (!sessionId) return null;
  const projects = path.join(home, ".claude", "projects");
  const direct = path.join(projects, encodeProjectPath(cwd), `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;

  try {
    for (const entry of readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(projects, entry.name, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // The directory may not exist yet; the bridge does not create it.
  }
  return null;
}

export function buildArgs(prompt, opts = {}) {
  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--permission-mode", opts.permission_mode || "acceptEdits",
  ];
  if (opts.allowed_tools) args.push("--allowedTools", opts.allowed_tools);
  if (opts.resume_session_id) args.push("--resume", opts.resume_session_id);
  if (opts.max_turns) args.push("--max-turns", String(opts.max_turns));
  return args;
}

export function parseClaudeOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isDirectory(cwd) {
  try {
    return statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Spawn headless Claude Code, wait for it to exit, parse its JSON result.
// ---------------------------------------------------------------------------
export function runClaudeCode(prompt, opts = {}, config = {}) {
  const claudeBin = config.claudeBin ?? CLAUDE_BIN;
  const defaultProjectDir = config.defaultProjectDir ?? DEFAULT_PROJECT_DIR;
  const baseUrl = config.baseUrl ?? DEEPSEEK_BASE_URL;
  const apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY;
  const cwd = opts.cwd || defaultProjectDir;

  if (!apiKey) {
    return Promise.resolve({
      ok: false,
      error: "DEEPSEEK_API_KEY is not set. Configure it in the MCP server env or the bridge key file.",
    });
  }
  if (!isDirectory(cwd)) {
    return Promise.resolve({ ok: false, error: `Working directory does not exist: ${cwd}` });
  }

  return new Promise((resolve) => {
    const args = buildArgs(prompt, opts);
    let child;
    try {
      child = spawn(claudeBin, args, {
        cwd,
        windowsHide: true,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_API_KEY: apiKey,
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

    const timeoutSec = opts.timeout_sec ?? 1800;
    const timeoutMs = timeoutSec * 1000;
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
          error: `Claude Code exceeded the ${timeoutSec}s timeout and was killed.`,
          stdout_tail: stdout.slice(-2000),
          stderr_tail: stderr.slice(-2000),
        });
        return;
      }

      const parsed = parseClaudeOutput(stdout);
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
export const server = new McpServer(
  { name: "claude-code-bridge", version: "0.1.0" },
  { instructions: INSTRUCTIONS }
);

server.tool(
  "claude_run",
  "Run Claude Code (headless, DeepSeek-backed) to write/edit code and run commands in the project. Blocks until Claude Code finishes and returns its result.",
  {
    prompt: z.string().min(1)
      .describe("Instructions for Claude Code: the initial task, or specific feedback when continuing via resume_session_id."),
    cwd: z.string().min(1).optional()
      .describe(`Working directory. Defaults to ${DEFAULT_PROJECT_DIR}.`),
    permission_mode: z.string().min(1).optional()
      .describe("Claude Code --permission-mode. Defaults to 'acceptEdits'."),
    allowed_tools: z.string().optional()
      .describe("Claude Code --allowedTools, e.g. 'Read,Edit,Bash(npm test)'."),
    resume_session_id: z.string().min(1).optional()
      .describe("session_id from a prior claude_run call, to continue that conversation with feedback."),
    max_turns: z.number().int().positive().optional()
      .describe("Claude Code --max-turns."),
    timeout_sec: z.number().positive().optional()
      .describe("Hard timeout in seconds before the process is killed. Defaults to 1800."),
  },
  async (args) => {
    const result = await runClaudeCode(args.prompt, args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Keep the module importable by tests without starting the stdio server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await server.connect(new StdioServerTransport());
}
