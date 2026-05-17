import test from "node:test";
import assert from "node:assert/strict";
import {
  buildArgs,
  cleanupTemp,
  createClaudeRunner,
  extractClaudeText,
  runClaude,
} from "./claude-runner.ts";
import { HarnessError } from "../../domain/model/types.ts";

test("extractClaudeText prefers structured output when text result is empty", () => {
  const text = extractClaudeText({
    result: "",
    structured_output: { ok: true, route: "claudeOpusReview" },
    session_id: "session",
    is_error: false,
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
    },
  });

  assert.equal(text, JSON.stringify({ ok: true, route: "claudeOpusReview" }));
});

test("extractClaudeText prefers structured output over explanatory text", () => {
  const text = extractClaudeText({
    result: "Human-readable explanation that should not be parsed as review JSON.",
    structured_output: { issues: [] },
    session_id: "session",
    is_error: false,
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
    },
  });

  assert.equal(text, JSON.stringify({ issues: [] }));
});

test("buildArgs includes optional flags and stores large system prompts in a temp file", () => {
  const writes: Array<{ path: string; content: string }> = [];
  const { args, tempFile } = buildArgs(
    {
      prompt: "hello",
      outputFormat: "stream-json",
      agent: "reviewer",
      model: "sonnet",
      allowedTools: ["Read(src/**)"],
      appendSystemPrompt: "system prompt",
      resume: "session-1",
      mcpConfigs: ["mcp.json"],
      outputSchema: { type: "object" },
    },
    {
      mkdtempSyncImpl: (() => "/tmp/harness-abcd") as any,
      writeFileSyncImpl: (filePath, content) => {
        writes.push({ path: String(filePath), content: String(content) });
      },
    },
  );

  assert.equal(tempFile, "/tmp/harness-abcd/system-prompt.txt");
  assert.deepEqual(writes, [{ path: "/tmp/harness-abcd/system-prompt.txt", content: "system prompt" }]);
  assert.deepEqual(args, [
    "-p",
    "-",
    "--output-format",
    "stream-json",
    "--agent",
    "reviewer",
    "--model",
    "sonnet",
    "--allowedTools",
    "Read(src/**)",
    "--append-system-prompt-file",
    "/tmp/harness-abcd/system-prompt.txt",
    "--resume",
    "session-1",
    "--mcp-config",
    "mcp.json",
    "--json-schema",
    "{\"type\":\"object\"}",
  ]);
});

test("cleanupTemp removes the temp directory and ignores cleanup errors", () => {
  const removed: string[] = [];
  cleanupTemp("/tmp/harness-1/system-prompt.txt", {
    rmSyncImpl: (target) => {
      removed.push(String(target));
    },
  });
  cleanupTemp("/tmp/harness-2/system-prompt.txt", {
    rmSyncImpl: () => {
      throw new Error("ignore");
    },
  });
  assert.deepEqual(removed, ["/tmp/harness-1"]);
});

test("runClaude logs successful command output and parses JSON", async () => {
  const calls: Array<{ command: string; args: string[]; stdin: string }> = [];
  const logs: string[] = [];
  const result = await runClaude(
    {
      prompt: "prompt text",
      cwd: "/repo",
      timeoutMs: 5000,
      allowedTools: ["Read(src/**)"],
      outputFormat: "json",
    },
    {
      logCommand(command: string, args: string[], outcome: { exitCode: number }) {
        logs.push(`${command}:${args.join(" ")}:${outcome.exitCode}`);
      },
    } as any,
    {
      spawnWithStdinImpl: async (command, args, stdin, cwd, timeoutMs) => {
        calls.push({ command, args, stdin });
        assert.equal(cwd, "/repo");
        assert.equal(timeoutMs, 5000);
        return {
          stdout: JSON.stringify({
            result: "done",
            session_id: "session-1",
            is_error: false,
            total_cost_usd: 1.25,
            usage: { input_tokens: 10, output_tokens: 2 },
          }),
          stderr: "",
          exitCode: 0,
        };
      },
    },
  );

  assert.equal(result.result, "done");
  assert.equal(result.session_id, "session-1");
  assert.deepEqual(calls, [{
    command: "claude",
    args: ["-p", "-", "--output-format", "json", "--allowedTools", "Read(src/**)"],
    stdin: "prompt text",
  }]);
  assert.deepEqual(logs, ["claude:-p (stdin) - --output-format json --allowedTools Read(src/**):0"]);
});

test("runClaude fails on process errors, invalid JSON, and is_error payloads", async () => {
  await assert.rejects(
    () => runClaude(
      { prompt: "prompt" },
      undefined,
      {
        spawnWithStdinImpl: async () => ({ stdout: "", stderr: "bad", exitCode: 2 }),
      },
    ),
    (error: unknown) => error instanceof HarnessError && error.message.includes("exit 2"),
  );

  await assert.rejects(
    () => runClaude(
      { prompt: "prompt" },
      undefined,
      {
        spawnWithStdinImpl: async () => ({ stdout: "not-json", stderr: "", exitCode: 0 }),
      },
    ),
    (error: unknown) => error instanceof HarnessError && error.message.includes("不正なJSON"),
  );

  await assert.rejects(
    () => runClaude(
      { prompt: "prompt" },
      undefined,
      {
        spawnWithStdinImpl: async () => ({
          stdout: JSON.stringify({
            result: "failed",
            session_id: "s",
            is_error: true,
            total_cost_usd: 0,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          stderr: "",
          exitCode: 0,
        }),
      },
    ),
    (error: unknown) => error instanceof HarnessError && error.message.includes("is_error=true"),
  );
});

test("createClaudeRunner maps request fields to runClaude and aggregates usage metadata", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const runner = createClaudeRunner(
    { timeoutMs: 2000, model: "default-model" },
    {
      runClaudeImpl: async (request) => {
        requests.push(request as Record<string, unknown>);
        return {
          result: "",
          structured_output: { issues: [] },
          session_id: "session-9",
          is_error: false,
          total_cost_usd: 0.5,
          usage: {
            input_tokens: 10,
            output_tokens: 3,
            cache_creation_input_tokens: 4,
            cache_read_input_tokens: 5,
          },
        };
      },
    },
  );

  const response = await runner.run({
    prompt: "review this",
    allowedTools: ["Read(src/**)"],
    appendSystemPrompt: "sys",
    sessionId: "resume-1",
    cwd: "/repo",
    agent: "reviewer",
    mcpConfigs: ["mcp.json"],
    outputSchema: { type: "array" },
  } as any);

  assert.equal(response.text, JSON.stringify({ issues: [] }));
  assert.equal(response.sessionId, "session-9");
  assert.deepEqual(response.metadata, {
    costUsd: 0.5,
    inputTokens: 19,
    outputTokens: 3,
    cacheCreationInputTokens: 4,
    cacheReadInputTokens: 5,
  });
  assert.deepEqual(requests, [{
    prompt: "review this",
    allowedTools: ["Read(src/**)"],
    appendSystemPrompt: "sys",
    resume: "resume-1",
    outputFormat: "json",
    cwd: "/repo",
    timeoutMs: 2000,
    agent: "reviewer",
    mcpConfigs: ["mcp.json"],
    model: "default-model",
    outputSchema: { type: "array" },
  }]);
});
