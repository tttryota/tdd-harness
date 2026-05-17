import type { CheckpointData, CommandResult } from "../../domain/model/types.ts";
import type { RunnerUsageSummary } from "../../infrastructure/logging/logger.ts";

export type Logger = {
  log(event: string, data?: Record<string, unknown>): void;
  logCommand(tool: string, args: string[], result: CommandResult): void;
  logTranscript(tool: string, direction: "client" | "server" | "stderr", message: string): void;
  saveReviewData(data: unknown): void;
  saveCheckpoint(data: CheckpointData): void;
  loadCheckpoint(): CheckpointData | null;
  clearCheckpoint(): void;
  summarizeRunnerUsage(): RunnerUsageSummary;
};
