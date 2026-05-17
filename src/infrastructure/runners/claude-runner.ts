import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HarnessError } from "../../domain/model/types.ts";
import type { ClaudeResult } from "../../domain/model/types.ts";
import type { Logger } from "../../application/ports/logger.ts";
import { spawnWithStdin } from "../process/spawn.ts";
import { RUNNER_CAPABILITY } from "./runner.ts";
import type { Runner, RunnerResponse } from "./runner.ts";

export type ClaudeOptions = {
  prompt: string;
  allowedTools?: string[];
  appendSystemPrompt?: string;
  resume?: string;
  outputFormat?: "json" | "text" | "stream-json";
  cwd?: string;
  timeoutMs?: number;
  agent?: string;
  mcpConfigs?: string[];
  model?: string;
  outputSchema?: Record<string, unknown>;
};

export type ClaudeDeps = {
  spawnWithStdinImpl?: typeof spawnWithStdin;
  mkdtempSyncImpl?: typeof mkdtempSync;
  writeFileSyncImpl?: typeof writeFileSync;
  rmSyncImpl?: typeof rmSync;
  tmpdirImpl?: typeof tmpdir;
};

export async function runClaude(
  options: ClaudeOptions,
  logger?: Logger,
  deps: ClaudeDeps = {},
): Promise<ClaudeResult> {
  const { args, tempFile } = buildArgs(
    { ...options, outputFormat: options.outputFormat ?? "json" },
    deps,
  );
  const result = await (deps.spawnWithStdinImpl ?? spawnWithStdin)(
    "claude",
    args,
    options.prompt,
    options.cwd,
    options.timeoutMs,
  );
  if (tempFile) cleanupTemp(tempFile, deps);

  if (logger) {
    logger.logCommand("claude", ["-p", "(stdin)", ...args.slice(1)], result);
  }

  if (result.exitCode !== 0) {
    throw new HarnessError(
      `claude -p failed (exit ${result.exitCode}): ${result.stderr}`,
    );
  }

  let parsed: ClaudeResult;
  try {
    parsed = JSON.parse(result.stdout) as ClaudeResult;
  } catch {
    throw new HarnessError(
      `claude -p の出力が不正なJSONです: ${result.stdout.slice(0, 200)}`,
    );
  }

  // Claude が exit 0 でも内部エラーを報告する場合がある
  if (parsed.is_error) {
    throw new HarnessError(
      `claude -p returned is_error=true: ${parsed.result}`,
    );
  }

  return parsed;
}

export function extractClaudeText(result: ClaudeResult): string {
  if (result.structured_output !== undefined) {
    return JSON.stringify(result.structured_output);
  }
  if (result.result) {
    return result.result;
  }
  return "";
}

export function buildArgs(
  options: ClaudeOptions,
  deps: ClaudeDeps = {},
): { args: string[]; tempFile: string | null } {
  // prompt は stdin 経由で渡すので "-p" に "-" を指定
  const args = ["-p", "-"];
  let tempFile: string | null = null;

  if (options.outputFormat) {
    args.push("--output-format", options.outputFormat);
  }

  if (options.agent) {
    args.push("--agent", options.agent);
  }

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.allowedTools && options.allowedTools.length > 0) {
    args.push("--allowedTools", options.allowedTools.join(","));
  }

  if (options.appendSystemPrompt) {
    // 大きな system prompt は一時ファイル経由で渡す（E2BIG 防止）
    const dir = (deps.mkdtempSyncImpl ?? mkdtempSync)(join((deps.tmpdirImpl ?? tmpdir)(), "harness-"));
    tempFile = join(dir, "system-prompt.txt");
    (deps.writeFileSyncImpl ?? writeFileSync)(tempFile, options.appendSystemPrompt, "utf-8");
    args.push("--append-system-prompt-file", tempFile);
  }

  if (options.resume) {
    args.push("--resume", options.resume);
  }

  for (const mcpConfig of options.mcpConfigs ?? []) {
    args.push("--mcp-config", mcpConfig);
  }

  if (options.outputSchema) {
    args.push("--json-schema", JSON.stringify(options.outputSchema));
  }

  return { args, tempFile };
}

export function cleanupTemp(filePath: string, deps: ClaudeDeps = {}): void {
  try {
    // ファイルと親ディレクトリ（mkdtempSync で作成）を両方削除
    const dir = join(filePath, "..");
    (deps.rmSyncImpl ?? rmSync)(dir, { recursive: true, force: true });
  } catch {
    // ベストエフォート
  }
}

export function createClaudeRunner(
  defaults?: { timeoutMs?: number; model?: string },
  deps: ClaudeDeps & {
    runClaudeImpl?: typeof runClaude;
  } = {},
): Runner {
  return {
    name: "claude",
    capabilities: new Set([
      RUNNER_CAPABILITY.SESSION_RESUME,
      RUNNER_CAPABILITY.ALLOWED_TOOLS,
      RUNNER_CAPABILITY.SYSTEM_PROMPT,
      RUNNER_CAPABILITY.AGENT,
      RUNNER_CAPABILITY.MCP_CONFIG,
    ]),
    async run(request, logger) {
      const result = await (deps.runClaudeImpl ?? runClaude)(
        {
          prompt: request.prompt,
          allowedTools: request.allowedTools,
          appendSystemPrompt: request.appendSystemPrompt,
          resume: request.sessionId,
          outputFormat: "json",
          cwd: request.cwd,
          timeoutMs: request.timeoutMs ?? defaults?.timeoutMs,
          agent: request.agent,
          mcpConfigs: request.mcpConfigs,
          model: request.model ?? defaults?.model,
          outputSchema: request.outputSchema,
        },
        logger,
        deps,
      );
      return {
        text: extractClaudeText(result),
        sessionId: result.session_id,
        metadata: {
          costUsd: result.total_cost_usd,
          inputTokens: result.usage.input_tokens
            + (result.usage.cache_creation_input_tokens ?? 0)
            + (result.usage.cache_read_input_tokens ?? 0),
          outputTokens: result.usage.output_tokens,
          cacheCreationInputTokens: result.usage.cache_creation_input_tokens ?? 0,
          cacheReadInputTokens: result.usage.cache_read_input_tokens ?? 0,
        },
      } satisfies RunnerResponse;
    },
  };
}
