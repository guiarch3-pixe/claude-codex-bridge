import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(path.join(tmpdir(), "claude-bridge-mcp-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const fakeClaude = path.join(tmp, "fake-claude.js");
writeFileSync(fakeClaude,
  '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({session_id:"sess-mcp",result:"ok",is_error:false,total_cost_usd:0,num_turns:1}));\n');
chmodSync(fakeClaude, 0o755);

test("MCP server exposes claude_run and returns the fake child result", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "server.js")],
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: "test-key",
      CLAUDE_BRIDGE_CLAUDE_BIN: fakeClaude,
      CLAUDE_BRIDGE_PROJECT_DIR: tmp,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "bridge-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "claude_run"));

    const result = await client.callTool({
      name: "claude_run",
      arguments: { prompt: "hello" },
    });
    const text = result.content.find((item) => item.type === "text")?.text;
    const parsed = JSON.parse(text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.session_id, "sess-mcp");
    assert.equal(parsed.result_text, "ok");
  } finally {
    await client.close();
  }
});
