import type { Logger } from "../../application/ports/logger.ts";

export const RUNNER_CAPABILITY = {
  SESSION_RESUME: "session_resume",
  ALLOWED_TOOLS: "allowed_tools",
  SYSTEM_PROMPT: "system_prompt",
  AGENT: "agent",
  MCP_CONFIG: "mcp_config",
  REVIEW_API: "review_api",
} as const;

export type RunnerCapability = (typeof RUNNER_CAPABILITY)[keyof typeof RUNNER_CAPABILITY];

export type RunnerRequest = {
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
  allowedTools?: string[];
  appendSystemPrompt?: string;
  sessionId?: string;
  agent?: string;
  mcpConfigs?: string[];
  model?: string;
  effort?: "minimal" | "low" | "medium" | "high";
  summary?: "auto" | "brief" | "detailed";
  personality?: "default" | "strict" | "balanced";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  sandboxPolicy?: "read-only" | "workspace-write" | "danger-full-access";
  outputSchema?: Record<string, unknown>;
};

export type RunnerReviewRequest = {
  cwd?: string;
  timeoutMs?: number;
  sessionId?: string;
  instructions: string;
  delivery?: "inline" | "detached";
};

export type RunnerResponse = {
  text: string;
  sessionId?: string;
  metadata?: {
    costUsd?: number | null;
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
};

export type Runner = {
  readonly name: string;
  readonly capabilities: ReadonlySet<RunnerCapability>;
  run(request: RunnerRequest, logger?: Logger): Promise<RunnerResponse>;
  review?(request: RunnerReviewRequest, logger?: Logger): Promise<RunnerResponse>;
};

export function prepareRequest(runner: Runner, request: RunnerRequest): RunnerRequest {
  const prepared = { ...request };

  if (prepared.appendSystemPrompt && !runner.capabilities.has(RUNNER_CAPABILITY.SYSTEM_PROMPT)) {
    prepared.prompt = `${prepared.prompt}\n\n---\n## Additional Context\n${prepared.appendSystemPrompt}`;
    prepared.appendSystemPrompt = undefined;
  }

  if (prepared.sessionId && !runner.capabilities.has(RUNNER_CAPABILITY.SESSION_RESUME)) {
    prepared.sessionId = undefined;
  }

  if (prepared.agent && !runner.capabilities.has(RUNNER_CAPABILITY.AGENT)) {
    prepared.agent = undefined;
  }

  if (prepared.mcpConfigs && !runner.capabilities.has(RUNNER_CAPABILITY.MCP_CONFIG)) {
    prepared.mcpConfigs = undefined;
  }

  if (prepared.allowedTools && !runner.capabilities.has(RUNNER_CAPABILITY.ALLOWED_TOOLS)) {
    const writePatterns = prepared.allowedTools.filter(t => t.startsWith("Write(") || t.startsWith("Edit("));
    if (writePatterns.length > 0) {
      prepared.prompt += `\n\n## File Scope Constraint\nOnly modify files matching: ${writePatterns.join(", ")}`;
    }
    prepared.allowedTools = undefined;
  }

  return prepared;
}
