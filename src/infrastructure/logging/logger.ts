import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { CommandResult, CheckpointData } from "../../domain/model/types.ts";
import { EVENT } from "../../domain/model/types.ts";

export const DEFAULT_LOG_BASE_DIR = ".harness/logs";

type LoggerOptions = {
  baseDir?: string;
  redactOutput?: boolean;
  resume?: boolean;
};

export type RunnerUsageTotals = {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type RunnerUsageSummary = {
  total: RunnerUsageTotals;
  byStep: Record<string, RunnerUsageTotals>;
};

const REDACT_PATTERNS = [
  // Anthropic
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /ANTHROPIC_API_KEY\s*=\s*\S+/g,
  // OpenAI
  /sk-proj-[a-zA-Z0-9_-]{20,}/g,
  /sess-[a-zA-Z0-9_-]{20,}/g,
  // GitHub PAT
  /ghp_[a-zA-Z0-9]{36,}/g,
  /github_pat_[a-zA-Z0-9_]{20,}/g,
  /gho_[a-zA-Z0-9]{36,}/g,
  // AWS
  /AKIA[A-Z0-9]{16}/g,
  /aws_secret_access_key\s*=\s*\S+/gi,
  // Generic
  /Bearer\s+[a-zA-Z0-9._-]+/g,
  /xoxb-[a-zA-Z0-9-]+/g,
  /xoxp-[a-zA-Z0-9-]+/g,
];

export function redact(text: string): string {
  let result = text;
  for (const pattern of REDACT_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

export class HarnessLogger {
  private baseDir: string;
  private taskName: string;
  private logDir: string;
  private harnessLogPath: string;
  private redactOutput: boolean;

  constructor(taskName: string, options?: LoggerOptions) {
    this.baseDir = options?.baseDir ?? DEFAULT_LOG_BASE_DIR;
    this.redactOutput = options?.redactOutput ?? true;

    // パストラバーサル防止: taskName から危険な文字を除去
    this.taskName = taskName.replace(/[./\\]/g, "_");

    if (options?.resume) {
      const restored = this.loadCheckpointFromBase();
      if (restored?.logDir && existsSync(restored.logDir)) {
        this.logDir = restored.logDir;
        this.harnessLogPath = join(this.logDir, "harness.jsonl");
        return;
      }
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    this.logDir = join(this.baseDir, `${timestamp}_${this.taskName}`);
    mkdirSync(this.logDir, { recursive: true });
    this.harnessLogPath = join(this.logDir, "harness.jsonl");
  }

  private checkpointBasePath(): string {
    return join(this.baseDir, `checkpoint_${this.taskName}.json`);
  }

  private loadCheckpointFromBase(): CheckpointData | null {
    const p = this.checkpointBasePath();
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf-8")) as CheckpointData;
    } catch {
      return null;
    }
  }

  log(event: string, data?: Record<string, unknown>): void {
    const entry = {
      ts: new Date().toISOString(),
      event,
      ...data,
    };
    const line = this.redactOutput
      ? redact(JSON.stringify(entry))
      : JSON.stringify(entry);
    appendFileSync(this.harnessLogPath, line + "\n", "utf-8");
  }

  logCommand(
    tool: string,
    args: string[],
    result: CommandResult,
  ): void {
    const logFileName =
      tool === "codex" ? "codex-review.log" : "claude-code.log";
    const logPath = join(this.logDir, logFileName);
    const rawEntry = [
      `=== ${new Date().toISOString()} ===`,
      `Command: ${tool} ${args.join(" ")}`,
      `Exit code: ${result.exitCode}`,
      `--- stdout ---`,
      result.stdout,
      `--- stderr ---`,
      result.stderr,
      "",
    ].join("\n");
    const entry = this.redactOutput ? redact(rawEntry) : rawEntry;
    appendFileSync(logPath, entry, "utf-8");
  }

  logTranscript(
    tool: string,
    direction: "client" | "server" | "stderr",
    message: string,
  ): void {
    const logFileName =
      tool === "codex-app-server" ? "codex-app-server.log" : `${tool}.log`;
    const logPath = join(this.logDir, logFileName);
    const rawEntry = [
      `=== ${new Date().toISOString()} ===`,
      `[${direction}]`,
      message,
      "",
    ].join("\n");
    const entry = this.redactOutput ? redact(rawEntry) : rawEntry;
    appendFileSync(logPath, entry, "utf-8");
  }

  saveReviewData(data: unknown): void {
    const dataPath = join(this.logDir, "review-data.json");
    const content = JSON.stringify(data, null, 2);
    writeFileSync(dataPath, this.redactOutput ? redact(content) : content, "utf-8");
  }

  saveCheckpoint(data: CheckpointData): void {
    const withLogDir = { ...data, logDir: this.logDir };
    const json = JSON.stringify(withLogDir, null, 2);
    // ログディレクトリ内（アーカイブ用）
    writeFileSync(join(this.logDir, "checkpoint.json"), json, "utf-8");
    // ベースディレクトリ（resume 用の固定パス）
    writeFileSync(this.checkpointBasePath(), json, "utf-8");
  }

  loadCheckpoint(): CheckpointData | null {
    return this.loadCheckpointFromBase();
  }

  clearCheckpoint(): void {
    for (const p of [join(this.logDir, "checkpoint.json"), this.checkpointBasePath()]) {
      if (existsSync(p)) unlinkSync(p);
    }
  }

  getLogDir(): string {
    return this.logDir;
  }

  summarizeRunnerUsage(): RunnerUsageSummary {
    return summarizeRunnerUsageFromLog(this.harnessLogPath);
  }
}

export function summarizeRunnerUsageFromLog(logPath: string): RunnerUsageSummary {
  const emptyTotals = (): RunnerUsageTotals => ({
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  });
  const summary: RunnerUsageSummary = {
    total: emptyTotals(),
    byStep: {},
  };

  if (!existsSync(logPath)) return summary;

  const lines = readFileSync(logPath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.event !== EVENT.RUNNER_USAGE || typeof parsed.step !== "string") {
      continue;
    }

    const step = parsed.step;
    const totals = summary.byStep[step] ?? emptyTotals();
    totals.runs += 1;
    totals.inputTokens += numberOrZero(parsed.inputTokens);
    totals.outputTokens += numberOrZero(parsed.outputTokens);
    totals.costUsd += numberOrZero(parsed.costUsd);
    summary.byStep[step] = totals;

    summary.total.runs += 1;
    summary.total.inputTokens += numberOrZero(parsed.inputTokens);
    summary.total.outputTokens += numberOrZero(parsed.outputTokens);
    summary.total.costUsd += numberOrZero(parsed.costUsd);
  }

  return summary;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
