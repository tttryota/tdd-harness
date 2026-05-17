import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeRunnerUsageFromLog } from "../../infrastructure/logging/logger.ts";
import type { ReviewRecord } from "../../domain/model/types.ts";
import { GuardError } from "../../domain/model/types.ts";

type BenchmarkMetrics = {
  label: string;
  reviewCycles: number;
  fixCount: number;
  acceptedCount: number;
  greenAttempts: number;
  alreadyGreen: boolean;
  totalRuns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

type ReviewDataShape = {
  records?: ReviewRecord[];
  tdd?: {
    greenAttempts?: number;
    alreadyGreen?: boolean;
  };
  usageSummary?: {
    total?: {
      runs?: number;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
    };
  };
};

export function renderBenchmarkSummary(logDirs: string[]): string {
  if (logDirs.length === 0 || logDirs.length > 2) {
    throw new GuardError("benchmark-summary には 1 つまたは 2 つの log directory を指定してください。");
  }

  const metrics = logDirs.map(loadMetrics);
  if (metrics.length === 1) {
    return renderSingle(metrics[0]);
  }
  return renderDiff(metrics[0], metrics[1]);
}

function loadMetrics(logDir: string): BenchmarkMetrics {
  const reviewDataPath = join(logDir, "review-data.json");
  if (!existsSync(reviewDataPath)) {
    throw new GuardError(`review-data.json が見つかりません: ${reviewDataPath}`);
  }

  const parsed = JSON.parse(readFileSync(reviewDataPath, "utf-8")) as ReviewDataShape;
  const records = parsed.records ?? [];
  const usageSummary = parsed.usageSummary?.total ?? summarizeRunnerUsageFromLog(join(logDir, "harness.jsonl")).total;
  const activeRecords = records.filter((record) => record.step !== "design_decision" && record.decision !== "accepted");
  const fixedRecords = activeRecords.filter((record) => record.decision === "fixed");

  return {
    label: logDir,
    reviewCycles: activeRecords.length,
    fixCount: fixedRecords.reduce((sum, record) => sum + record.findings.length, 0),
    acceptedCount: records.filter((record) => record.decision === "accepted").length,
    greenAttempts: parsed.tdd?.greenAttempts ?? 0,
    alreadyGreen: parsed.tdd?.alreadyGreen ?? false,
    totalRuns: usageSummary.runs ?? 0,
    inputTokens: usageSummary.inputTokens ?? 0,
    outputTokens: usageSummary.outputTokens ?? 0,
    costUsd: usageSummary.costUsd ?? 0,
  };
}

function renderSingle(metrics: BenchmarkMetrics): string {
  return [
    `Benchmark summary: ${metrics.label}`,
    `- Review cycles: ${metrics.reviewCycles}`,
    `- Fixed findings: ${metrics.fixCount}`,
    `- Accepted findings: ${metrics.acceptedCount}`,
    `- Green attempts: ${metrics.alreadyGreen ? "already green" : metrics.greenAttempts}`,
    `- LLM runs: ${metrics.totalRuns}`,
    `- Input tokens: ${metrics.inputTokens}`,
    `- Output tokens: ${metrics.outputTokens}`,
    `- Cost USD: ${metrics.costUsd.toFixed(4)}`,
  ].join("\n");
}

function renderDiff(before: BenchmarkMetrics, after: BenchmarkMetrics): string {
  const rows: Array<[string, number | string, number | string, string]> = [
    ["Review cycles", before.reviewCycles, after.reviewCycles, formatDelta(after.reviewCycles - before.reviewCycles)],
    ["Fixed findings", before.fixCount, after.fixCount, formatDelta(after.fixCount - before.fixCount)],
    ["Accepted findings", before.acceptedCount, after.acceptedCount, formatDelta(after.acceptedCount - before.acceptedCount)],
    ["LLM runs", before.totalRuns, after.totalRuns, formatDelta(after.totalRuns - before.totalRuns)],
    ["Input tokens", before.inputTokens, after.inputTokens, formatDelta(after.inputTokens - before.inputTokens)],
    ["Output tokens", before.outputTokens, after.outputTokens, formatDelta(after.outputTokens - before.outputTokens)],
    ["Cost USD", before.costUsd.toFixed(4), after.costUsd.toFixed(4), formatDelta(after.costUsd - before.costUsd, 4)],
  ];

  const header = [
    `Benchmark diff`,
    `- Before: ${before.label}`,
    `- After: ${after.label}`,
    "",
    `| Metric | Before | After | Delta |`,
    `|---|---:|---:|---:|`,
  ];
  const body = rows.map(([label, beforeValue, afterValue, delta]) => `| ${label} | ${beforeValue} | ${afterValue} | ${delta} |`);
  return [...header, ...body].join("\n");
}

function formatDelta(value: number, digits = 0): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(digits)}`;
}
