import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBenchmarkSummary } from "./benchmark-summary.ts";
import { GuardError } from "../../domain/model/types.ts";

function writeLogDir(name: string, reviewData: object, harnessLog?: string): string {
  const dir = mkdtempSync(join(tmpdir(), `harness-benchmark-${name}-`));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "review-data.json"), JSON.stringify(reviewData, null, 2), "utf-8");
  if (harnessLog) {
    writeFileSync(join(dir, "harness.jsonl"), harnessLog, "utf-8");
  }
  return dir;
}

test("renderBenchmarkSummary renders single and diff summaries", () => {
  const before = writeLogDir("before", {
    records: [{ step: "impl", decision: "fixed", findings: [{}, {}] }, { step: "impl", decision: "accepted", findings: [] }],
    tdd: { greenAttempts: 2, alreadyGreen: false },
    usageSummary: { total: { runs: 3, inputTokens: 10, outputTokens: 5, costUsd: 0.25 } },
  });
  const after = writeLogDir("after", {
    records: [{ step: "impl", decision: "fixed", findings: [{}] }],
    tdd: { greenAttempts: 1, alreadyGreen: true },
  }, JSON.stringify({ event: "runner_usage", step: "impl", inputTokens: 5, outputTokens: 2, costUsd: 0.1 }) + "\n");

  assert.match(renderBenchmarkSummary([before]), /Review cycles: 1/);
  const diff = renderBenchmarkSummary([before, after]);
  assert.match(diff, /\| Review cycles \| 1 \| 1 \| 0 \|/);
  assert.match(diff, /\| Cost USD \| 0.2500 \| 0.1000 \| -0.1500 \|/);
});

test("renderBenchmarkSummary validates inputs", () => {
  assert.throws(() => renderBenchmarkSummary([]), GuardError);
  const dir = mkdtempSync(join(tmpdir(), "harness-benchmark-missing-"));
  assert.throws(() => renderBenchmarkSummary([dir]), GuardError);
});
