import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildArgs,
  encodeProjectPath,
  nativeTranscriptPath,
  parseClaudeOutput,
  runClaudeCode,
} from "../server.js";

const tmp = mkdtempSync(path.join(tmpdir(), "claude-bridge-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function fakeClaude(name, body) {
  const file = path.join(tmp, name);
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

const okClaude = fakeClaude("fake-ok.js",
  'process.stdout.write(JSON.stringify({session_id:"sess-1",result:"done",is_error:false,total_cost_usd:0.01,num_turns:1}));');
const badClaude = fakeClaude("fake-bad.js", 'process.stdout.write("not json");');
const slowClaude = fakeClaude("fake-slow.js", 'setTimeout(() => {}, 5000);');

test("buildArgs maps Claude Code flags", () => {
  assert.deepEqual(buildArgs("hello"), [
    "-p", "hello", "--output-format", "json", "--permission-mode", "acceptEdits",
  ]);
  assert.deepEqual(
    buildArgs("hello", {
      permission_mode: "plan",
      allowed_tools: "Read,Edit",
      resume_session_id: "sess-1",
      max_turns: 3,
    }),
    [
      "-p", "hello", "--output-format", "json", "--permission-mode", "plan",
      "--allowedTools", "Read,Edit", "--resume", "sess-1", "--max-turns", "3",
    ],
  );
});

test("parseClaudeOutput rejects empty or non-JSON output", () => {
  assert.equal(parseClaudeOutput(""), null);
  assert.equal(parseClaudeOutput("  "), null);
  assert.equal(parseClaudeOutput("not json"), null);
  assert.deepEqual(parseClaudeOutput(' {"result":"x"} '), { result: "x" });
});

test("encodeProjectPath and nativeTranscriptPath resolve an existing transcript", () => {
  const home = path.join(tmp, "home");
  const projectDir = path.join(home, ".claude", "projects", "-tmp-project");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, "sess-1.jsonl"), "");

  assert.equal(encodeProjectPath("/tmp/project"), "-tmp-project");
  assert.equal(
    nativeTranscriptPath("/tmp/project", "sess-1", home),
    path.join(projectDir, "sess-1.jsonl"),
  );
  assert.equal(nativeTranscriptPath("/tmp/project", "missing", home), null);
  assert.equal(nativeTranscriptPath("/tmp/project", null, home), null);
});

test("nativeTranscriptPath falls back to searching by session id", () => {
  const home = path.join(tmp, "home-fallback");
  const projectDir = path.join(home, ".claude", "projects", "some-other-encoding");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, "sess-2.jsonl"), "");

  assert.equal(
    nativeTranscriptPath("/tmp/project", "sess-2", home),
    path.join(projectDir, "sess-2.jsonl"),
  );
});

test("runClaudeCode returns parsed result from a successful child", async () => {
  const result = await runClaudeCode(
    "hello",
    { cwd: tmp },
    { claudeBin: okClaude, defaultProjectDir: tmp, apiKey: "test-key" },
  );
  assert.equal(result.ok, true);
  assert.equal(result.exit_code, 0);
  assert.equal(result.session_id, "sess-1");
  assert.equal(result.result_text, "done");
  assert.equal(result.num_turns, 1);
});

test("runClaudeCode reports missing key, bad cwd and unparseable output", async () => {
  const noKey = await runClaudeCode("hello", { cwd: tmp }, { claudeBin: okClaude, apiKey: "" });
  assert.equal(noKey.ok, false);
  assert.match(noKey.error, /DEEPSEEK_API_KEY/);

  const badCwd = await runClaudeCode(
    "hello",
    { cwd: path.join(tmp, "does-not-exist") },
    { claudeBin: okClaude, apiKey: "test-key" },
  );
  assert.equal(badCwd.ok, false);
  assert.match(badCwd.error, /Working directory/);

  const badOutput = await runClaudeCode(
    "hello",
    { cwd: tmp },
    { claudeBin: badClaude, apiKey: "test-key" },
  );
  assert.equal(badOutput.ok, false);
  assert.match(badOutput.error, /parse Claude Code output/);
});

test("runClaudeCode enforces the timeout", async () => {
  const result = await runClaudeCode(
    "hello",
    { cwd: tmp, timeout_sec: 0.2 },
    { claudeBin: slowClaude, apiKey: "test-key" },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /timeout/);
});
