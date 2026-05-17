import type { Logger } from "../../../application/ports/logger.ts";
import type { RunnerRequest, RunnerResponse, RunnerReviewRequest } from "../runner.ts";
import { HarnessError, RunnerRateLimitError } from "../../../domain/model/types.ts";
import type {
  ApprovalPolicy,
  ReviewExecution,
  SandboxSpec,
  ThreadSession,
  TurnExecution,
} from "./domain.ts";
import type {
  AgentMessageDeltaNotification,
  ItemCompletedNotification,
  JsonRpcNotification,
  ReviewStartParams,
  ReviewStartResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadTokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnStartParams,
  TurnStartResponse,
} from "./protocol.ts";
import type { AppServerTransport } from "./transport.ts";

export class CodexConversationService {
  private transport: AppServerTransport;
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private logger?: Logger;

  constructor(
    transport: AppServerTransport,
    options?: { logger?: Logger },
  ) {
    this.transport = transport;
    this.logger = options?.logger;
  }

  async runTurn(
    request: RunnerRequest,
    defaults: {
      cwd?: string;
      sandbox?: SandboxSpec;
      model?: string;
      approvalPolicy?: ApprovalPolicy;
      personality?: "default" | "strict" | "balanced";
    },
  ): Promise<RunnerResponse> {
    await this.ensureInitialized();
    const session = await this.ensureThread(request, defaults);
    const collector = new TurnEventCollector(session.threadId);
    const unsubscribe = this.transport.subscribe((notification) => {
      collector.consume(notification);
    });

    try {
      const startResult = await this.transport.request(
        "turn/start",
        this.toTurnStartParams(session.threadId, request, defaults),
        request.timeoutMs,
      ) as TurnStartResponse;
      const completed = await collector.waitForTurn(startResult.turn.id, request.timeoutMs);
      return {
        text: completed.text,
        sessionId: completed.threadId,
        metadata: completed.tokenUsage
          ? {
              inputTokens: completed.tokenUsage.inputTokens + completed.tokenUsage.cachedInputTokens,
              outputTokens: completed.tokenUsage.outputTokens,
              cacheReadInputTokens: completed.tokenUsage.cachedInputTokens,
              cacheCreationInputTokens: 0,
              costUsd: null,
            }
          : undefined,
      };
    } finally {
      unsubscribe();
    }
  }

  async runReview(
    request: RunnerReviewRequest,
    defaults: {
      cwd?: string;
      sandbox?: SandboxSpec;
      model?: string;
      approvalPolicy?: ApprovalPolicy;
      personality?: "default" | "strict" | "balanced";
    },
  ): Promise<RunnerResponse> {
    await this.ensureInitialized();
    const session = await this.ensureThread(
      {
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
        sessionId: request.sessionId,
        approvalPolicy: defaults.approvalPolicy,
        sandboxPolicy: defaults.sandbox,
        model: defaults.model,
        personality: defaults.personality,
      },
      defaults,
    );
    const collector = new TurnEventCollector(session.threadId);
    const unsubscribe = this.transport.subscribe((notification) => {
      collector.consume(notification);
    });

    try {
      const startResult = await this.transport.request(
        "review/start",
        {
          threadId: session.threadId,
          target: {
            type: "custom",
            instructions: request.instructions,
          },
          delivery: request.delivery ?? "detached",
        } satisfies ReviewStartParams,
        request.timeoutMs,
      ) as ReviewStartResponse;
      const completed = await collector.waitForReview(
        startResult.reviewThreadId,
        startResult.turn.id,
        request.timeoutMs,
      );
      return {
        text: completed.text,
        sessionId: completed.reviewThreadId,
        metadata: completed.tokenUsage
          ? {
              inputTokens: completed.tokenUsage.inputTokens + completed.tokenUsage.cachedInputTokens,
              outputTokens: completed.tokenUsage.outputTokens,
              cacheReadInputTokens: completed.tokenUsage.cachedInputTokens,
              cacheCreationInputTokens: 0,
              costUsd: null,
            }
          : undefined,
      };
    } finally {
      unsubscribe();
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }

    this.initializePromise = this.transport.request(
        "initialize",
        {
          clientInfo: {
          name: "obsidian-harness",
          title: "Obsidian Harness",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      },
    ).then(() => {
      this.initialized = true;
    });

    await this.initializePromise;
  }

  private async ensureThread(
    request: Pick<
      RunnerRequest,
      "cwd" | "sessionId" | "appendSystemPrompt" | "approvalPolicy" | "model" | "personality" | "sandboxPolicy" | "timeoutMs"
    >,
    defaults: {
      cwd?: string;
      sandbox?: SandboxSpec;
      model?: string;
      approvalPolicy?: ApprovalPolicy;
      personality?: "default" | "strict" | "balanced";
    },
  ): Promise<ThreadSession> {
    const developerInstructions = request.appendSystemPrompt;
    if (request.sessionId) {
      const response = await this.transport.request(
        "thread/resume",
        {
          threadId: request.sessionId,
          cwd: request.cwd ?? defaults.cwd ?? null,
          approvalPolicy: request.approvalPolicy ?? defaults.approvalPolicy ?? "never",
          sandbox: request.sandboxPolicy ?? defaults.sandbox ?? "read-only",
          developerInstructions: developerInstructions ?? null,
          personality: request.personality ?? defaults.personality ?? null,
          excludeTurns: true,
          persistExtendedHistory: true,
        } satisfies ThreadResumeParams,
        request.timeoutMs,
      ) as ThreadResumeResponse;

      return {
        threadId: response.thread.id,
        cwd: request.cwd ?? defaults.cwd,
        developerInstructions,
      };
    }

    const response = await this.transport.request(
      "thread/start",
      {
        model: request.model ?? defaults.model ?? null,
        cwd: request.cwd ?? defaults.cwd ?? null,
        approvalPolicy: request.approvalPolicy ?? defaults.approvalPolicy ?? "never",
        sandbox: request.sandboxPolicy ?? defaults.sandbox ?? "read-only",
        developerInstructions: developerInstructions ?? null,
        personality: request.personality ?? defaults.personality ?? null,
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      } satisfies ThreadStartParams,
      request.timeoutMs,
    ) as ThreadStartResponse;

    return {
      threadId: response.thread.id,
      cwd: request.cwd ?? defaults.cwd,
      developerInstructions,
    };
  }

  private toTurnStartParams(
    threadId: string,
    request: RunnerRequest,
    defaults: {
      cwd?: string;
      sandbox?: SandboxSpec;
      model?: string;
      approvalPolicy?: ApprovalPolicy;
      personality?: "default" | "strict" | "balanced";
    },
  ): TurnStartParams {
    return {
      threadId,
      input: [{ type: "text", text: request.prompt, text_elements: [] }],
      cwd: request.cwd ?? defaults.cwd ?? null,
      approvalPolicy: request.approvalPolicy ?? defaults.approvalPolicy ?? "never",
      sandboxPolicy: this.mapSandboxPolicy(
        request.sandboxPolicy ?? defaults.sandbox ?? "read-only",
        request.cwd ?? defaults.cwd,
      ),
      model: request.model ?? defaults.model ?? null,
      effort: request.effort ?? null,
      summary: request.summary ?? null,
      personality: request.personality ?? defaults.personality ?? null,
      outputSchema: request.outputSchema ?? null,
    };
  }

  private mapSandboxPolicy(sandbox: SandboxSpec, cwd?: string) {
    if (sandbox === "danger-full-access") {
      return { type: "dangerFullAccess" } as const;
    }
    if (sandbox === "read-only") {
      return { type: "readOnly", networkAccess: true } as const;
    }
    return {
      type: "workspaceWrite",
      writableRoots: cwd ? [cwd] : ([] as string[]),
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    } as const;
  }
}

class TurnEventCollector {
  private threadId: string;
  private targetThreadId: string;
  private turnId = "";
  private reviewText = "";
  private itemBuffers = new Map<string, string>();
  private agentMessages: Array<{ phase: "commentary" | "final_answer" | null; text: string }> = [];
  private tokenUsage?: TurnExecution["tokenUsage"];
  private settled = false;
  private resolve?: (result: TurnExecution | ReviewExecution) => void;
  private reject?: (error: unknown) => void;
  private timeout: NodeJS.Timeout | null = null;

  constructor(threadId: string) {
    this.threadId = threadId;
    this.targetThreadId = threadId;
  }

  consume(notification: JsonRpcNotification): void {
    switch (notification.method) {
      case "item/agentMessage/delta":
        this.handleAgentDelta(notification.params as AgentMessageDeltaNotification);
        return;
      case "item/completed":
        this.handleItemCompleted(notification.params as ItemCompletedNotification);
        return;
      case "thread/tokenUsage/updated":
        this.handleTokenUsage(notification.params as ThreadTokenUsageUpdatedNotification);
        return;
      case "turn/completed":
        this.handleTurnCompleted(notification.params as TurnCompletedNotification);
        return;
      default:
        return;
    }
  }

  waitForTurn(turnId: string, timeoutMs?: number): Promise<TurnExecution> {
    this.turnId = turnId;
    this.targetThreadId = this.threadId;
    return this.wait(timeoutMs) as Promise<TurnExecution>;
  }

  waitForReview(reviewThreadId: string, turnId: string, timeoutMs?: number): Promise<ReviewExecution> {
    this.turnId = turnId;
    this.targetThreadId = reviewThreadId;
    return this.wait(timeoutMs) as Promise<ReviewExecution>;
  }

  private wait(timeoutMs?: number): Promise<TurnExecution | ReviewExecution> {
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      if (!timeoutMs) return;
      this.timeout = setTimeout(() => {
        reject(new HarnessError("codex app-server turn did not complete in time"));
      }, timeoutMs);
    });
  }

  private handleAgentDelta(notification: AgentMessageDeltaNotification): void {
    if (!this.matches(notification.threadId, notification.turnId)) return;
    const current = this.itemBuffers.get(notification.itemId) ?? "";
    this.itemBuffers.set(notification.itemId, current + notification.delta);
  }

  private handleItemCompleted(notification: ItemCompletedNotification): void {
    if (!this.matches(notification.threadId, notification.turnId)) return;

    if (notification.item.type === "agentMessage") {
      const item = notification.item as {
        id: string;
        text: string;
        phase: "commentary" | "final_answer" | null;
      };
      const deltaText = item.id
        ? (this.itemBuffers.get(item.id) ?? "")
        : "";
      const text = item.text || deltaText;
      this.agentMessages.push({
        phase: item.phase ?? null,
        text,
      });
      return;
    }

    if (notification.item.type === "exitedReviewMode") {
      this.reviewText = (notification.item as { review: string }).review;
    }
  }

  private handleTokenUsage(notification: ThreadTokenUsageUpdatedNotification): void {
    if (!this.matches(notification.threadId, notification.turnId)) return;
    this.tokenUsage = {
      inputTokens: notification.tokenUsage.last.inputTokens,
      outputTokens: notification.tokenUsage.last.outputTokens,
      cachedInputTokens: notification.tokenUsage.last.cachedInputTokens,
      reasoningOutputTokens: notification.tokenUsage.last.reasoningOutputTokens,
    };
  }

  private handleTurnCompleted(notification: TurnCompletedNotification): void {
    if (!this.matches(notification.threadId, notification.turn.id)) return;
    if (this.settled) return;
    this.settled = true;
    if (this.timeout) clearTimeout(this.timeout);

    if (notification.turn.status === "failed" || notification.turn.error) {
      this.reject?.(normalizeTurnError(notification.turn.error));
      return;
    }

    const text = this.reviewText || this.collectFinalText();
    if (this.reviewText) {
      this.resolve?.({
        threadId: this.threadId,
        turnId: notification.turn.id,
        reviewThreadId: notification.threadId,
        text,
        tokenUsage: this.tokenUsage,
      });
      return;
    }

    this.resolve?.({
      threadId: notification.threadId,
      turnId: notification.turn.id,
      text,
      tokenUsage: this.tokenUsage,
    });
  }

  private collectFinalText(): string {
    const finalMessages = this.agentMessages
      .filter((message) => message.phase === "final_answer")
      .map((message) => message.text.trim())
      .filter(Boolean);
    if (finalMessages.length > 0) {
      return finalMessages.join("\n\n");
    }

    const allMessages = this.agentMessages
      .map((message) => message.text.trim())
      .filter(Boolean);
    return allMessages.join("\n\n");
  }

  private matches(threadId: string, turnId: string): boolean {
    return threadId === this.targetThreadId && turnId === this.turnId;
  }
}

function normalizeTurnError(
  error: { message: string; codexErrorInfo?: string | { [key: string]: unknown } | null } | null,
): HarnessError {
  const message = error?.message ?? "codex app-server turn failed";
  const info = error?.codexErrorInfo;
  const infoText = typeof info === "string" ? info : JSON.stringify(info ?? null);

  if (/429|limit|usageLimitExceeded|serverOverloaded/i.test(`${message} ${infoText}`)) {
    return new RunnerRateLimitError("codex", message);
  }

  return new HarnessError(message);
}
