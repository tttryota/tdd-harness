import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessLogger } from "../../infrastructure/logging/logger.ts";
import { ReviewOrchestrator } from "./review-orchestrator.ts";
import type { ReviewIssue, ReviewResult } from "../../domain/model/types.ts";
import type { LintViolation } from "../../domain/model/types.ts";
import { DriftError } from "../../domain/model/types.ts";

function createOrchestrator() {
  const root = mkdtempSync(join(tmpdir(), "harness-review-more-"));
  const specPath = join(root, "spec.md");
  writeFileSync(specPath, "# spec\n", "utf-8");
  const logger = new HarnessLogger("review-more", { baseDir: root });
  const registry = {
    getConfig() {
      return { templates: {} };
    },
    getRunner() {
      return {
        async run() {
          return { text: "{\"checklist\":[{\"item\":\"ok\",\"verdict\":\"pass\",\"evidence\":\"done\"}],\"issues\":[]}" };
        },
      };
    },
    isStepSkipped() {
      return false;
    },
    getFallbackRunner() {
      return this.getRunner();
    },
  } as any;
  const lintGuard = { async check() {} } as any;
  return { root, specPath, orchestrator: new ReviewOrchestrator(logger, lintGuard, root, registry) };
}

function major(description: string): ReviewIssue {
  return { file: "target.ts", severity: "major", description };
}

function minor(description: string): ReviewIssue {
  return { file: "target.ts", severity: "minor", description };
}

test("parseReviewResult accepts fenced JSON and invalid issue shapes fail closed", () => {
  const { orchestrator } = createOrchestrator();
  const parsed = (orchestrator as any).parseReviewResult(
    "reviewer",
    "```json\n{\"checklist\":[{\"item\":\"x\",\"verdict\":\"pass\",\"evidence\":\"ok\"}],\"issues\":[]}\n```",
  ) as ReviewResult;
  assert.equal(parsed.isLgtm, true);

  const invalid = (orchestrator as any).parseReviewResult(
    "reviewer",
    "{\"checklist\":[{\"item\":\"x\",\"verdict\":\"pass\",\"evidence\":\"ok\"}],\"issues\":[{\"severity\":\"major\",\"file\":\"x\"}]}",
  ) as ReviewResult;
  assert.equal(invalid.isLgtm, false);
  assert.equal(invalid.issues[0]?.severity, "critical");
});

test("reconcileReviews keeps major issues and only confirmed minor issues", () => {
  const { orchestrator } = createOrchestrator();
  const issues = orchestrator.reconcileReviews(
    { reviewer: "a", checklist: [], issues: [major("fix me"), minor("same minor"), minor("single")], isLgtm: false },
    { reviewer: "b", checklist: [], issues: [minor("same minor")], isLgtm: false },
  );

  assert.equal(issues.some((issue) => issue.description === "fix me"), true);
  assert.equal(issues.filter((issue) => issue.description === "same minor").length, 2);
  assert.equal(issues.some((issue) => issue.description === "single"), false);
});

test("runPageReview accepts clean pages, escalates parse failures, and can accept repeated minors", async () => {
  const { orchestrator, specPath } = createOrchestrator();
  const page = orchestrator as any;
  page.pageDesignReview = async () => ({ reviewer: "design", checklist: [], issues: [], isLgtm: true });
  page.pageBehaviorReview = async () => ({ reviewer: "behavior", checklist: [], issues: [], isLgtm: true });
  page.pageCodeReview = async () => ({ reviewer: "code", checklist: [], issues: [], isLgtm: true });
  const lgtmResults = await orchestrator.runPageReview({
    targetFiles: ["target.ts"],
    specPath,
    componentSpecPath: specPath,
    dependenciesText: "",
    figmaSlice: "",
    browserScenariosText: "",
    criteriaPaths: [],
    scopeAllowedTools: [],
  } as any);
  assert.equal(lgtmResults.length, 3);

  const { orchestrator: parseFail, specPath: parseSpec } = createOrchestrator();
  const failing = parseFail as any;
  failing.pageDesignReview = async () => ({ reviewer: "design", checklist: [], issues: [{ file: "", severity: "critical", description: "parse" }], isLgtm: false });
  failing.pageBehaviorReview = async () => ({ reviewer: "behavior", checklist: [], issues: [], isLgtm: true });
  failing.pageCodeReview = async () => ({ reviewer: "code", checklist: [], issues: [], isLgtm: true });
  await assert.rejects(
    () => parseFail.runPageReview({
      targetFiles: ["target.ts"],
      specPath: parseSpec,
      componentSpecPath: parseSpec,
      dependenciesText: "",
      figmaSlice: "",
      browserScenariosText: "",
      criteriaPaths: [],
      scopeAllowedTools: [],
    } as any),
    DriftError,
  );

  const { orchestrator: minorFlow, specPath: minorSpec } = createOrchestrator();
  const minorAny = minorFlow as any;
  let pageFixes = 0;
  let judgeCalls = 0;
  let reviewCycles = 0;
  minorAny.pageDesignReview = async () => ({ reviewer: "design", checklist: [], issues: [minor("tiny")], isLgtm: false });
  minorAny.pageBehaviorReview = async () => ({ reviewer: "behavior", checklist: [], issues: [], isLgtm: true });
  minorAny.pageCodeReview = async () => {
    reviewCycles++;
    return { reviewer: "code", checklist: [], issues: [], isLgtm: true };
  };
  minorAny.applyFixes = async () => { pageFixes++; };
  minorAny.generateJudgmentSummary = async () => "fixed";
  minorAny.judgeMinorAcceptance = async () => {
    judgeCalls++;
    return { safe: true, reason: "acceptable" };
  };
  await minorFlow.runPageReview({
    targetFiles: ["target.ts"],
    specPath: minorSpec,
    componentSpecPath: minorSpec,
    dependenciesText: "",
    figmaSlice: "",
    browserScenariosText: "",
    criteriaPaths: [],
    scopeAllowedTools: [],
    getFileDiff: async () => "",
  } as any);
  const records = minorFlow.getRecords();
  assert.equal(reviewCycles, 2);
  assert.equal(pageFixes, 1);
  assert.equal(judgeCalls, 1);
  assert.equal(records.at(-1)?.decision, "accepted");
  assert.equal(records.at(-1)?.reviewer, "page_review");
});

test("reviewStep fixes major issues and can retry unsafe minor issues", async () => {
  const { orchestrator, specPath } = createOrchestrator();
  const anyOrchestrator = orchestrator as any;
  const params = {
    targetFiles: ["target.ts"],
    scopeAllowedTools: [],
    specPath,
    getFileDiff: async () => "",
    runTests: async () => {},
    reviewMode: "implementation",
  };

  let majorCalls = 0;
  anyOrchestrator.applyFixes = async () => { majorCalls++; };
  anyOrchestrator.generateJudgmentSummary = async () => "summary";
  const fixed = await anyOrchestrator.reviewStep(
    async () => {
      majorCalls++;
      return majorCalls >= 2
        ? { reviewer: "self_quality", checklist: [], issues: [], isLgtm: true }
        : { reviewer: "self_quality", checklist: [], issues: [major("bad")], isLgtm: false };
    },
    params,
  );
  assert.equal(fixed.isLgtm, true);

  const { orchestrator: minorRetry, specPath: minorSpec } = createOrchestrator();
  const anyMinor = minorRetry as any;
  let calls = 0;
  anyMinor.applyFixes = async () => {};
  anyMinor.judgeMinorAcceptance = async () => ({ safe: false, reason: "retry once" });
  const result = await anyMinor.reviewStep(
    async () => {
      calls++;
      return calls >= 3
        ? { reviewer: "self_quality", checklist: [], issues: [], isLgtm: true }
        : { reviewer: "self_quality", checklist: [], issues: [minor("nit")], isLgtm: false };
    },
    {
      targetFiles: ["target.ts"],
      scopeAllowedTools: [],
      specPath: minorSpec,
      getFileDiff: async () => "",
      runTests: async () => {},
      reviewMode: "implementation",
    },
  );
  assert.equal(result.isLgtm, true);
});

test("reviewStep defers minor fixes while major issues remain", async () => {
  const { orchestrator, specPath } = createOrchestrator();
  const anyOrchestrator = orchestrator as any;
  const fixBatches: ReviewIssue[][] = [];
  let calls = 0;
  anyOrchestrator.applyFixes = async (issues: ReviewIssue[]) => { fixBatches.push(issues); };
  anyOrchestrator.generateJudgmentSummary = async () => "summary";

  const result = await anyOrchestrator.reviewStep(
    async () => {
      calls++;
      return calls >= 2
        ? { reviewer: "self_criteria", checklist: [], issues: [], isLgtm: true }
        : {
            reviewer: "self_criteria",
            checklist: [],
            issues: [major("must fix"), minor("can wait")],
            isLgtm: false,
          };
    },
    {
      targetFiles: ["target.ts"],
      scopeAllowedTools: [],
      specPath,
      getFileDiff: async () => "",
      runTests: async () => {},
      reviewMode: "implementation",
    },
  );

  assert.equal(result.isLgtm, true);
  assert.equal(fixBatches.length, 1);
  assert.deepEqual(fixBatches[0]?.map((issue) => issue.description), ["must fix"]);
});

test("reviewStep accepts manual-only minor issues without applyFixes", async () => {
  const { orchestrator, specPath } = createOrchestrator();
  const anyOrchestrator = orchestrator as any;
  let fixCalls = 0;
  anyOrchestrator.applyFixes = async () => { fixCalls++; };

  const result = await anyOrchestrator.reviewStep(
    async () => ({
      reviewer: "self_criteria",
      checklist: [],
      issues: [minor("[manual] file-wide constant extraction")],
      isLgtm: false,
    }),
    {
      targetFiles: ["target.ts"],
      scopeAllowedTools: [],
      specPath,
      getFileDiff: async () => "",
      runTests: async () => {},
      reviewMode: "implementation",
    },
  );

  assert.equal(result.isLgtm, false);
  assert.equal(fixCalls, 0);
  assert.equal(orchestrator.getRecords().at(-1)?.decision, "accepted");
});

test("reviewStep escalates manual blocking issues", async () => {
  const { orchestrator, specPath } = createOrchestrator();
  const anyOrchestrator = orchestrator as any;
  let fixCalls = 0;
  anyOrchestrator.applyFixes = async () => { fixCalls++; };

  await assert.rejects(
    () => anyOrchestrator.reviewStep(
      async () => ({
        reviewer: "self_criteria",
        checklist: [],
        issues: [major("[manual] changing validation order is required")],
        isLgtm: false,
      }),
      {
        targetFiles: ["target.ts"],
        scopeAllowedTools: [],
        specPath,
        getFileDiff: async () => "",
        runTests: async () => {},
        reviewMode: "implementation",
      },
    ),
    DriftError,
  );

  assert.equal(fixCalls, 0);
  assert.equal(orchestrator.getRecords().at(-1)?.decision, "escalated");
});

test("applyFixes reuses lint_fix during post-fix lint retries", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-review-lint-fix-"));
  const specPath = join(root, "spec.md");
  writeFileSync(specPath, "# spec\n", "utf-8");
  const logger = new HarnessLogger("review-lint-fix", { baseDir: root });
  const runnerCalls: Array<{ prompt: string; allowedTools?: string[] }> = [];
  const registry = {
    getConfig() {
      return { templates: {} };
    },
    getRunner() {
      return {
        async run(request: { prompt: string; allowedTools?: string[] }) {
          runnerCalls.push({ prompt: request.prompt, allowedTools: request.allowedTools });
          return { text: "{\"checklist\":[{\"item\":\"ok\",\"verdict\":\"pass\",\"evidence\":\"done\"}],\"issues\":[]}" };
        },
      };
    },
    isStepSkipped() {
      return false;
    },
    getFallbackRunner() {
      return this.getRunner();
    },
  } as any;

  let lintCheckCalls = 0;
  let rescanCalls = 0;
  const lintGuard = {
    async check(_files: string[], options?: { claudeFix?: (violations: LintViolation[]) => Promise<void>; rescanFiles?: () => Promise<string[]> }) {
      lintCheckCalls++;
      await options?.claudeFix?.([{ tool: "ruff", file: "src/file.py", line: 12, message: "BLE001: blind except" }]);
      await options?.rescanFiles?.();
    },
  } as any;

  const orchestrator = new ReviewOrchestrator(logger, lintGuard, root, registry);
  const anyOrchestrator = orchestrator as any;
  anyOrchestrator.executeRun = async (step: string, prompt: string) => {
    runnerCalls.push({ prompt: `${step}:${prompt}` });
  };

  await anyOrchestrator.applyFixes(
    [{ file: "src/file.py", line: 10, severity: "major", description: "fix review issue" }],
    {
      targetFiles: ["src/file.py"],
      scopeAllowedTools: ["Write(src/*)"],
      specPath,
      reviewMode: "implementation",
      rescanFiles: async () => {
        rescanCalls++;
        return ["src/file.py", "src/extra.py"];
      },
      runTests: async () => {},
    },
  );

  assert.equal(lintCheckCalls, 1);
  assert.equal(rescanCalls, 2);
  assert.equal(runnerCalls.some((call) => /同じ原因・同じパターンの未修正箇所/.test(call.prompt)), true);
  assert.equal(runnerCalls.some((call) => /新しいファイル、型定義、クラス、関数抽出、広い定数化などの構造変更はしない/.test(call.prompt)), true);
  assert.equal(runnerCalls.some((call) => /BLE001: blind except/.test(call.prompt)), true);
  assert.deepEqual(runnerCalls.at(-1)?.allowedTools, ["Write(src/*)"]);
});
