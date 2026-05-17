import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBenchmarkDiagnose } from "./benchmark-diagnose.ts";
import { DEFAULT_LOG_BASE_DIR } from "../../infrastructure/logging/logger.ts";

test("renderBenchmarkDiagnose summarizes a single log with optimization opportunities", () => {
  const workspace = mkdtempSync(join(tmpdir(), "benchmark-diagnose-"));
  const logDir = join(workspace, DEFAULT_LOG_BASE_DIR, "case");
  mkdirSync(logDir, { recursive: true });

  writeFileSync(join(logDir, "harness.jsonl"), [
    JSON.stringify({ ts: "2026-05-16T00:00:00.000Z", event: "review_start", mode: "impl-3-step" }),
    JSON.stringify({
      ts: "2026-05-16T00:02:00.000Z",
      event: "runner_usage",
      step: "impl_self_quality",
      runner: "claude",
      inputTokens: 120000,
      outputTokens: 6000,
      cacheReadInputTokens: 100000,
      cacheCreationInputTokens: 10000,
      costUsd: 0.6,
    }),
    JSON.stringify({
      ts: "2026-05-16T00:02:30.000Z",
      event: "runner_usage",
      step: "impl_external_review",
      runner: "codex",
      inputTokens: 30000,
      outputTokens: 500,
      cacheReadInputTokens: 20000,
      cacheCreationInputTokens: 0,
      costUsd: 0,
    }),
  ].join("\n"), "utf-8");

  writeFileSync(join(logDir, "review-data.json"), JSON.stringify({
    plan: { profile: "backend", scope: "benchmark/markdown-toc" },
    records: [
      { step: "self_quality", cycle: 1, reviewer: "self_quality", findings: [], decision: "lgtm", diffBefore: "", diffAfter: "", judgmentSummary: "none" },
      { step: "impl_external", cycle: 1, reviewer: "impl_external", findings: [{ severity: "major", file: "x.py", description: "bug" }], decision: "fixed", diffBefore: "", diffAfter: "", judgmentSummary: "fix" },
    ],
    tdd: { greenAttempts: 1, alreadyGreen: false },
  }), "utf-8");

  writeFileSync(join(logDir, "claude-code.log"), [
    "=== 2026-05-16T00:02:00.000Z ===",
    "Command: claude -p (stdin) - --output-format json",
    "Exit code: 0",
    "--- stdout ---",
    JSON.stringify({
      duration_ms: 120000,
      result: "{\"issues\":[]}",
      modelUsage: { "claude-opus-4-6": {} },
    }),
    "--- stderr ---",
  ].join("\n"), "utf-8");

  writeFileSync(join(logDir, "codex-app-server.log"), [
    "=== 2026-05-16T00:02:30.000Z ===",
    "[server]",
    "{\"method\":\"item/completed\",\"params\":{\"turnId\":\"turn-1\",\"item\":{\"type\":\"agentMessage\",\"text\":\"{\\\"issues\\\":[{\\\"severity\\\":\\\"major\\\"}]}\"}}}",
    "=== 2026-05-16T00:02:31.000Z ===",
    "[server]",
    "{\"method\":\"turn/completed\",\"params\":{\"turn\":{\"id\":\"turn-1\",\"durationMs\":30000}}}",
  ].join("\n"), "utf-8");

  const report = renderBenchmarkDiagnose([logDir], workspace);

  assert.match(report, /## Summary/);
  assert.match(report, /impl_self_quality/);
  assert.match(report, /Optimization Opportunities/);
  assert.match(report, /cache-read input が 100000 tokens/);
  assert.match(report, /self review は問題を見つけられず、後段の external review が 1 件検出/);
});

test("renderBenchmarkDiagnose compares two logs", () => {
  const workspace = mkdtempSync(join(tmpdir(), "benchmark-diagnose-diff-"));
  const beforeDir = join(workspace, DEFAULT_LOG_BASE_DIR, "before");
  const afterDir = join(workspace, DEFAULT_LOG_BASE_DIR, "after");
  mkdirSync(beforeDir, { recursive: true });
  mkdirSync(afterDir, { recursive: true });

  const writeHarness = (dir: string, wallSeconds: number, inputTokens: number, costUsd: number) => {
    writeFileSync(join(dir, "harness.jsonl"), [
      JSON.stringify({ ts: "2026-05-16T00:00:00.000Z", event: "review_start", mode: "impl-3-step" }),
      JSON.stringify({
        ts: new Date(Date.parse("2026-05-16T00:00:00.000Z") + wallSeconds * 1000).toISOString(),
        event: "runner_usage",
        step: "impl_self_quality",
        runner: "claude",
        inputTokens,
        outputTokens: 1000,
        cacheReadInputTokens: Math.floor(inputTokens * 0.7),
        cacheCreationInputTokens: 1000,
        costUsd,
      }),
    ].join("\n"), "utf-8");
    writeFileSync(join(dir, "review-data.json"), JSON.stringify({
      plan: { profile: "backend", scope: "benchmark/markdown-toc" },
      records: [],
      tdd: { greenAttempts: 1, alreadyGreen: false },
    }), "utf-8");
    writeFileSync(join(dir, "claude-code.log"), [
      "=== 2026-05-16T00:02:00.000Z ===",
      "Command: claude -p (stdin) - --output-format json",
      "Exit code: 0",
      "--- stdout ---",
      JSON.stringify({ duration_ms: wallSeconds * 1000, result: "ok", modelUsage: { "claude-opus-4-6": {} } }),
      "--- stderr ---",
    ].join("\n"), "utf-8");
  };

  writeHarness(beforeDir, 120, 100000, 0.5);
  writeHarness(afterDir, 60, 50000, 0.2);

  const report = renderBenchmarkDiagnose([beforeDir, afterDir], workspace);

  assert.match(report, /Benchmark diagnose diff/);
  assert.match(report, /Wall clock/);
  assert.match(report, /improved/);
  assert.match(report, /impl_self_quality/);
});

test("renderBenchmarkDiagnose flags real benchmark hotspots from the latest completed log", () => {
  const projectRoot = new URL("../..", import.meta.url).pathname;
  const logDir = findLatestBenchmarkLogDir(projectRoot);
  if (!logDir) {
    return;
  }

  const report = renderBenchmarkDiagnose([logDir], projectRoot);

  assert.match(report, /impl_self_quality/);
  assert.match(report, /test_generate/);
  assert.match(report, /apply_fixes/);
  assert.match(report, /Optimization Opportunities/);
});

function findLatestBenchmarkLogDir(projectRoot: string): string | null {
  const baseDir = join(projectRoot, DEFAULT_LOG_BASE_DIR);
  if (!existsSync(baseDir)) return null;
  const candidates = readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith("_impl_benchmark_markdown-toc"))
    .map((entry) => join(baseDir, entry.name))
    .filter((candidate) => hasCompletedBenchmarkUsage(candidate))
    .sort();
  return candidates.at(-1) ?? null;
}

function hasCompletedBenchmarkUsage(logDir: string): boolean {
  const harnessPath = join(logDir, "harness.jsonl");
  if (!existsSync(harnessPath)) return false;
  const text = readFileSync(harnessPath, "utf-8");
  return text.includes("\"event\":\"runner_usage\"") && text.includes("\"step\":\"impl_self_quality\"");
}
