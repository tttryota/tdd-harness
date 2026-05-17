import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessLogger } from "../../infrastructure/logging/logger.ts";
import { ReviewOrchestrator } from "./review-orchestrator.ts";
import type { Runner } from "../../infrastructure/runners/runner.ts";

test("ReviewOrchestrator uses runner.run for external implementation review", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-review-"));
  const targetFile = join(workspace, "target.ts");
  const specFile = join(workspace, "spec.md");
  writeFileSync(targetFile, "export const value = 1;\n", "utf-8");
  writeFileSync(specFile, "# spec\n", "utf-8");

  let reviewCalls = 0;
  let runCalls = 0;
  const runner: Runner = {
    name: "codex",
    capabilities: new Set(),
    async run() {
      runCalls += 1;
      return { text: "{\"checklist\":[{\"item\":\"spec\",\"verdict\":\"pass\",\"evidence\":\"checked target.ts\"}],\"issues\":[]}" };
    },
    async review() {
      reviewCalls += 1;
      return { text: "{\"checklist\":[{\"item\":\"spec\",\"verdict\":\"fail\",\"evidence\":\"wrong path\"}],\"issues\":[{\"file\":\"x\",\"severity\":\"major\",\"description\":\"wrong path\"}]}" };
    },
  };

  const registry = {
    getRunner() {
      return runner;
    },
    getConfig() {
      return {
        templates: {},
      };
    },
  } as any;

  const logger = new HarnessLogger("review-test", { baseDir: workspace });
  const orchestrator = new ReviewOrchestrator(logger, {} as never, workspace, registry);
  const result = await (orchestrator as any).externalImplementationReview([targetFile], specFile);

  assert.equal(result.isLgtm, true);
  assert.equal(reviewCalls, 0);
  assert.equal(runCalls, 1);
});

test("ReviewOrchestrator skips external test review when skipExternalReview is set", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-test-review-"));
  const targetFile = join(workspace, "target.test.ts");
  const specFile = join(workspace, "spec.md");
  const testCasesFile = join(workspace, "test-cases.md");
  writeFileSync(targetFile, "describe('value', () => { it('works', () => { expect(true).toBe(true); }); });\n", "utf-8");
  writeFileSync(specFile, "# spec\n", "utf-8");
  writeFileSync(testCasesFile, "# test cases\n", "utf-8");

  let reviewCalls = 0;
  let runCalls = 0;
  const runner: Runner = {
    name: "codex",
    capabilities: new Set(),
    async run() {
      runCalls += 1;
      return { text: "{\"checklist\":[{\"item\":\"target cases\",\"verdict\":\"pass\",\"evidence\":\"checked target.test.ts\"}],\"issues\":[]}" };
    },
    async review() {
      reviewCalls += 1;
      return { text: "{\"checklist\":[{\"item\":\"target cases\",\"verdict\":\"pass\",\"evidence\":\"checked target.test.ts\"}],\"issues\":[]}" };
    },
  };

  const registry = {
    getRunner() {
      return runner;
    },
    getConfig() {
      return {
        templates: {},
      };
    },
    isStepSkipped() {
      return false;
    },
  } as any;

  const logger = new HarnessLogger("review-test-skip-external", { baseDir: workspace });
  const orchestrator = new ReviewOrchestrator(logger, {} as never, workspace, registry);
  const results = await orchestrator.runReview({
    targetFiles: [targetFile],
    specPath: specFile,
    criteriaPaths: [],
    scopeAllowedTools: [],
    reviewMode: "test",
    skipExternalReview: true,
    testCasesPath: testCasesFile,
  });

  assert.equal(results.length, 1);
  assert.equal(runCalls, 1);
  assert.equal(reviewCalls, 0);
});

test("parseReviewResult fails closed when checklist is missing", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-review-parse-"));
  const logger = new HarnessLogger("review-parse-test", { baseDir: workspace });
  const orchestrator = new ReviewOrchestrator(logger, {} as never, workspace, {} as never);

  const result = (orchestrator as any).parseReviewResult("self_quality", "{\"issues\":[]}");

  assert.equal(result.isLgtm, false);
  assert.equal(result.issues[0]?.severity, "critical");
});
