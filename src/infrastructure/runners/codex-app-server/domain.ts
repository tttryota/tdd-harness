export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";

export type SandboxSpec = "read-only" | "workspace-write" | "danger-full-access";

export type RunnerPersonality = "default" | "strict" | "balanced";

export type RunnerSummary = "auto" | "brief" | "detailed";

export type RunnerEffort = "minimal" | "low" | "medium" | "high";

export type ThreadSession = {
  threadId: string;
  cwd?: string;
  developerInstructions?: string;
};

export type TurnExecution = {
  threadId: string;
  turnId: string;
  text: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningOutputTokens: number;
  };
};

export type ReviewExecution = {
  threadId: string;
  turnId: string;
  reviewThreadId: string;
  text: string;
  tokenUsage?: TurnExecution["tokenUsage"];
};
