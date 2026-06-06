import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessLogger } from "../../infrastructure/logging/logger.ts";
import { ReviewOrchestrator } from "./review-orchestrator.ts";
import type { Runner } from "../../infrastructure/runners/runner.ts";

test("`ReviewOrchestrator` は implementation の external review で `runner.run` を使う", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-review-"));
  const targetFile = join(workspace, "target.ts");
  const specFile = join(workspace, "spec.md");
  writeFileSync(targetFile, "export const value = 1;\n", "utf-8");
  writeFileSync(specFile, "# spec\n", "utf-8");

  let reviewCalls = 0;
  let runCalls = 0;
  let prompt = "";
  const runner: Runner = {
    name: "codex",
    capabilities: new Set(),
    async run(request) {
      runCalls += 1;
      prompt = request.prompt;
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
  const result = await (orchestrator as any).externalImplementationReview(
    [targetFile],
    specFile,
    async () => "@@ -1 +1 @@\n-export const value = 0;\n+export const value = 1;\n",
  );

  assert.equal(result.isLgtm, true);
  assert.equal(reviewCalls, 0);
  assert.equal(runCalls, 1);
  assert.match(prompt, /## 変更 diff/);
  assert.match(prompt, /export const value = 1/);
  assert.match(prompt, /# spec/);
});

test("`ReviewOrchestrator` は `skipExternalReview` 指定時に test の external review を skip する", async () => {
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

test("`ReviewOrchestrator` は implementation criteria review に spec 本文を含める", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-review-criteria-spec-"));
  const targetFile = join(workspace, "target.ts");
  const specFile = join(workspace, "spec.md");
  const criteriaFile = join(workspace, "criteria.md");
  writeFileSync(targetFile, "export const value = 1;\n", "utf-8");
  writeFileSync(specFile, "# spec\n\n## スコープ外\n- do not require rollback\n", "utf-8");
  writeFileSync(criteriaFile, "# criteria\n", "utf-8");

  let prompt = "";
  let appendSystemPrompt = "";
  const runner: Runner = {
    name: "codex",
    capabilities: new Set(),
    async run(request) {
      prompt = request.prompt;
      appendSystemPrompt = request.appendSystemPrompt ?? "";
      return { text: "{\"checklist\":[{\"item\":\"criteria\",\"verdict\":\"pass\",\"evidence\":\"checked target.ts\"}],\"issues\":[]}" };
    },
    async review() {
      return { text: "{\"checklist\":[{\"item\":\"criteria\",\"verdict\":\"pass\",\"evidence\":\"checked target.ts\"}],\"issues\":[]}" };
    },
  };

  const registry = {
    getRunner() {
      return runner;
    },
    getConfig() {
      return { templates: {} };
    },
  } as any;

  const logger = new HarnessLogger("review-criteria-spec", { baseDir: workspace });
  const orchestrator = new ReviewOrchestrator(logger, {} as never, workspace, registry);
  const result = await orchestrator.runImplementationCriteriaReview({
    targetFiles: [targetFile],
    specPath: specFile,
    criteriaPaths: [criteriaFile],
    scopeAllowedTools: [],
    reviewMode: "implementation",
  } as any);

  assert.equal(result.isLgtm, true);
  assert.match(prompt, /## 仕様書/);
  assert.match(prompt, /## スコープ外/);
  assert.match(prompt, /do not require rollback/);
  assert.match(appendSystemPrompt, /# criteria/);
});

test("`parseReviewResult` は checklist 欠落時に fail-closed で扱う", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-review-parse-"));
  const logger = new HarnessLogger("review-parse-test", { baseDir: workspace });
  const orchestrator = new ReviewOrchestrator(logger, {} as never, workspace, {} as never);

  const result = (orchestrator as any).parseReviewResult("self_quality", "{\"issues\":[]}");

  assert.equal(result.isLgtm, false);
  assert.equal(result.issues[0]?.severity, "critical");
});
