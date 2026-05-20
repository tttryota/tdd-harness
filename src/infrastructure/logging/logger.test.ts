import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessLogger, redact, summarizeRunnerUsageFromLog } from "./logger.ts";
import { EVENT } from "../../domain/model/types.ts";

test("redact masks common secret patterns", () => {
  const text = "sk-ant-12345678901234567890 Bearer abc.def";
  assert.match(redact(text), /\[REDACTED\]/);
});

test("HarnessLogger writes logs, checkpoints, and usage summaries", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-logger-"));
  const logger = new HarnessLogger("task/with.path", { baseDir: root });
  logger.log(EVENT.RUNNER_USAGE, { step: "impl", inputTokens: 10, outputTokens: 5, costUsd: 0.25 });
  logger.log(EVENT.REVIEW_RESULT, { step: "criteria", cycle: 1, issueCount: 2, decision: "fixed" });
  logger.logCommand("codex", ["-p"], { stdout: "ok", stderr: "", exitCode: 0 });
  logger.logTranscript("codex-app-server", "client", "hello");
  logger.saveReviewData({ ok: true });
  logger.saveCheckpoint({
    planPath: "plan.md",
    completedStep: "test_generated",
    sessionId: "sess-12345678901234567890",
    records: [],
    greenAttempt: 0,
    timestamp: "now",
  });

  const logDir = logger.getLogDir();
  assert.match(readFileSync(join(logDir, "harness.jsonl"), "utf-8"), /runner_usage/);
  assert.match(readFileSync(join(logDir, "harness.jsonl"), "utf-8"), /review_result/);
  assert.match(readFileSync(join(logDir, "codex-review.log"), "utf-8"), /Command: codex -p/);
  assert.match(readFileSync(join(logDir, "codex-app-server.log"), "utf-8"), /\[client\]/);
  assert.equal(logger.loadCheckpoint()?.logDir, logDir);
  assert.equal(logger.summarizeRunnerUsage().total.runs, 1);
  logger.clearCheckpoint();
  assert.equal(summarizeRunnerUsageFromLog(join(logDir, "harness.jsonl")).total.inputTokens, 10);
});
