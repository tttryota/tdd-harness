import type {
  ApprovalPolicy,
  RunnerEffort,
  RunnerPersonality,
  RunnerSummary,
  SandboxSpec,
} from "./domain.ts";

export type JsonRpcId = number;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
};

export type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcFailure;

export type InitializeParams = {
  clientInfo: {
    name: string;
    title: string | null;
    version: string;
  };
  capabilities: {
    experimentalApi: boolean;
    optOutNotificationMethods?: string[] | null;
  };
};

export type Thread = {
  id: string;
  cwd?: string | null;
};

export type Turn = {
  id: string;
  status: "running" | "completed" | "failed" | "interrupted";
  error: {
    message: string;
    codexErrorInfo?: string | { [key: string]: unknown } | null;
    additionalDetails?: string | null;
  } | null;
};

export type ThreadStartParams = {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: ApprovalPolicy | null;
  sandbox?: SandboxSpec | null;
  developerInstructions?: string | null;
  personality?: RunnerPersonality | null;
  experimentalRawEvents: boolean;
  persistExtendedHistory: boolean;
};

export type ThreadStartResponse = {
  thread: Thread;
};

export type ThreadResumeParams = {
  threadId: string;
  cwd?: string | null;
  approvalPolicy?: ApprovalPolicy | null;
  sandbox?: SandboxSpec | null;
  developerInstructions?: string | null;
  personality?: RunnerPersonality | null;
  excludeTurns: boolean;
  persistExtendedHistory: boolean;
};

export type ThreadResumeResponse = {
  thread: Thread;
};

export type UserInput = {
  type: "text";
  text: string;
  text_elements: [];
};

export type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

export type TurnStartParams = {
  threadId: string;
  input: UserInput[];
  cwd?: string | null;
  approvalPolicy?: ApprovalPolicy | null;
  sandboxPolicy?: SandboxPolicy | null;
  model?: string | null;
  effort?: RunnerEffort | null;
  summary?: RunnerSummary | null;
  personality?: RunnerPersonality | null;
  outputSchema?: Record<string, unknown> | null;
};

export type TurnStartResponse = {
  turn: Turn;
};

export type ReviewStartParams = {
  threadId: string;
  target: {
    type: "custom";
    instructions: string;
  };
  delivery?: "inline" | "detached" | null;
};

export type ReviewStartResponse = {
  turn: Turn;
  reviewThreadId: string;
};

export type AgentMessageItem = {
  type: "agentMessage";
  id: string;
  text: string;
  phase: "commentary" | "final_answer" | null;
};

export type ExitedReviewModeItem = {
  type: "exitedReviewMode";
  id: string;
  review: string;
};

export type ThreadItem = AgentMessageItem | ExitedReviewModeItem | {
  type: string;
  id?: string;
  [key: string]: unknown;
};

export type ItemCompletedNotification = {
  threadId: string;
  turnId: string;
  item: ThreadItem;
};

export type AgentMessageDeltaNotification = {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
};

export type TurnCompletedNotification = {
  threadId: string;
  turn: Turn;
};

export type ThreadTokenUsageUpdatedNotification = {
  threadId: string;
  turnId: string;
  tokenUsage: {
    total: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      reasoningOutputTokens: number;
      totalTokens: number;
    };
    last: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      reasoningOutputTokens: number;
      totalTokens: number;
    };
  };
};
