import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { HarnessError } from "../../../domain/model/types.ts";
import type { Logger } from "../../../application/ports/logger.ts";
import type {
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccess,
} from "./protocol.ts";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timeout: NodeJS.Timeout | null;
};

export type AppServerTransport = {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  subscribe(listener: (notification: JsonRpcNotification) => void): () => void;
  close(): Promise<void>;
};

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    stdio: ["pipe", "pipe", "pipe"];
  },
) => ChildProcessWithoutNullStreams;

export class StdioCodexAppServerTransport implements AppServerTransport {
  private logger?: Logger;
  private cwd?: string;
  private spawnImpl: SpawnLike;
  private command: string;
  private commandArgs: string[];
  private child: ReturnType<typeof spawn> | null = null;
  private nextId = 1;
  private stdoutBuffer = "";
  private listeners = new Set<(notification: JsonRpcNotification) => void>();
  private pending = new Map<JsonRpcId, PendingRequest>();
  private closed = false;
  private exitHandlersRegistered = false;

  constructor(options?: {
    cwd?: string;
    logger?: Logger;
    spawnImpl?: SpawnLike;
    command?: string;
    commandArgs?: string[];
  }) {
    this.cwd = options?.cwd;
    this.logger = options?.logger;
    this.spawnImpl = options?.spawnImpl ?? spawn;
    this.command = options?.command ?? "codex";
    this.commandArgs = options?.commandArgs ?? ["app-server", "--listen", "stdio://"];
  }

  setLogger(logger?: Logger): void {
    this.logger = logger;
  }

  subscribe(listener: (notification: JsonRpcNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    this.ensureStarted();

    const id = this.nextId++;
    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const raw = JSON.stringify(message);
    this.logger?.logTranscript("codex-app-server", "client", raw);
    const child = this.child;
    if (!child) {
      throw new HarnessError("codex app-server is not running");
    }
    child.stdin!.write(`${raw}\n`);

    return new Promise((resolve, reject) => {
      const timeout = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new HarnessError(`codex app-server request timed out: ${method}`));
          }, timeoutMs)
        : null;

      this.pending.set(id, { resolve, reject, timeout });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [id, pending] of this.pending.entries()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(new HarnessError(`codex app-server closed while request ${id} was pending`));
    }
    this.pending.clear();

    if (!this.child) return;
    this.child.kill();
    this.child = null;
  }

  private ensureStarted(): void {
    if (this.child) return;

    this.child = this.spawnImpl(this.command, this.commandArgs, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const child = this.child;
    if (!child) {
      throw new HarnessError("failed to start codex app-server");
    }
    this.registerExitHandlers();
    child.unref();

    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      this.stdoutBuffer += text;
      this.drainStdoutBuffer();
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      this.logger?.logTranscript("codex-app-server", "stderr", chunk.toString("utf-8"));
    });

    child.on("error", (error) => {
      this.rejectPending(new HarnessError(`failed to start codex app-server: ${error.message}`));
    });

    child.on("close", (code, signal) => {
      if (this.closed) return;
      this.rejectPending(
        new HarnessError(
          `codex app-server exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"})`,
        ),
      );
      this.child = null;
    });
  }

  private rejectPending(error: HarnessError): void {
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private drainStdoutBuffer(): void {
    while (true) {
      const lineBreakIndex = this.stdoutBuffer.indexOf("\n");
      if (lineBreakIndex === -1) return;

      const rawLine = this.stdoutBuffer.slice(0, lineBreakIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(lineBreakIndex + 1);
      if (!rawLine) continue;

      this.logger?.logTranscript("codex-app-server", "server", rawLine);

      let message: JsonRpcMessage;
      try {
        message = JSON.parse(rawLine) as JsonRpcMessage;
      } catch {
        continue;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if ("method" in message) {
      if ("id" in message) {
        this.replyUnsupportedRequest(message);
        return;
      }

      for (const listener of this.listeners) {
        listener(message);
      }
      return;
    }

    if (!("id" in message)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;

    this.pending.delete(message.id);
    if (pending.timeout) clearTimeout(pending.timeout);

    if ("error" in message) {
      pending.reject(this.toRpcError(message));
      return;
    }

    pending.resolve((message as JsonRpcSuccess).result);
  }

  private replyUnsupportedRequest(message: JsonRpcRequest): void {
    const response: JsonRpcFailure = {
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32000,
        message: `client cannot handle app-server request: ${message.method}`,
      },
    };
    const raw = JSON.stringify(response);
    this.logger?.logTranscript("codex-app-server", "client", raw);
    const child = this.child;
    if (!child) return;
    child.stdin!.write(`${raw}\n`);
  }

  private toRpcError(message: JsonRpcFailure): HarnessError {
    const suffix = message.error.data === undefined
      ? ""
      : ` ${JSON.stringify(message.error.data)}`;
    return new HarnessError(`codex app-server rpc error ${message.error.code}: ${message.error.message}${suffix}`);
  }

  private registerExitHandlers(): void {
    if (this.exitHandlersRegistered) return;
    this.exitHandlersRegistered = true;

    const shutdown = () => {
      if (!this.child) return;
      this.closed = true;
      this.child.kill();
      this.child = null;
    };

    process.once("exit", shutdown);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
}
