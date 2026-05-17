import test from "node:test";
import assert from "node:assert/strict";
import { prepareRequest, RUNNER_CAPABILITY, type Runner } from "./runner.ts";

test("prepareRequest inlines unsupported system prompts and strips unsupported capabilities", () => {
  const runner: Runner = {
    name: "generic",
    capabilities: new Set<never>(),
    async run() {
      return { text: "" };
    },
  };

  const prepared = prepareRequest(runner, {
    prompt: "base",
    appendSystemPrompt: "system text",
    sessionId: "resume-1",
    agent: "reviewer",
    mcpConfigs: ["mcp.json"],
    allowedTools: ["Read(src/**)", "Write(src/**)"],
  });

  assert.match(prepared.prompt, /Additional Context/);
  assert.match(prepared.prompt, /Only modify files matching: Write\(src\/\*\*\)/);
  assert.equal(prepared.appendSystemPrompt, undefined);
  assert.equal(prepared.sessionId, undefined);
  assert.equal(prepared.agent, undefined);
  assert.equal(prepared.mcpConfigs, undefined);
  assert.equal(prepared.allowedTools, undefined);
});

test("prepareRequest preserves fields for runners that support the capability set", () => {
  const runner: Runner = {
    name: "codex",
    capabilities: new Set([
      RUNNER_CAPABILITY.SYSTEM_PROMPT,
      RUNNER_CAPABILITY.SESSION_RESUME,
      RUNNER_CAPABILITY.AGENT,
      RUNNER_CAPABILITY.MCP_CONFIG,
      RUNNER_CAPABILITY.ALLOWED_TOOLS,
    ]),
    async run() {
      return { text: "" };
    },
  };

  const prepared = prepareRequest(runner, {
    prompt: "base",
    appendSystemPrompt: "system text",
    sessionId: "resume-1",
    agent: "reviewer",
    mcpConfigs: ["mcp.json"],
    allowedTools: ["Read(src/**)"],
  });

  assert.equal(prepared.appendSystemPrompt, "system text");
  assert.equal(prepared.sessionId, "resume-1");
  assert.equal(prepared.agent, "reviewer");
  assert.deepEqual(prepared.mcpConfigs, ["mcp.json"]);
  assert.deepEqual(prepared.allowedTools, ["Read(src/**)"]);
});
