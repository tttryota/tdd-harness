import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessLogger } from "../../infrastructure/logging/logger.ts";
import { ReviewOrchestrator } from "./review-orchestrator.ts";
import type { ReviewIssue, ReviewResult } from "../../domain/model/types.ts";
import type { LintViolation } from "../../domain/model/types.ts";
import { DriftError, EVENT, HarnessError } from "../../domain/model/types.ts";

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
  return { root, specPath, logger, orchestrator: new ReviewOrchestrator(logger, lintGuard, root, registry) };
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

test("reviewStep passes major and minor issues together into applyFixes", async () => {
  const { orchestrator, specPath } = createOrchestrator();
  const anyOrchestrator = orchestrator as any;
  const fixBatches: ReviewIssue[][] = [];
  let calls = 0;
  anyOrchestrator.applyFixes = async (issues: ReviewIssue[]) => { fixBatches.push(issues); };
  const result = await anyOrchestrator.reviewStep(
    async () => {
      calls++;
      return calls >= 2
        ? { reviewer: "self_criteria", checklist: [], issues: [], isLgtm: true }
        : {
            reviewer: "self_criteria",
            checklist: [],
            issues: [major("must fix"), minor("[manual] can wait")],
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
  assert.deepEqual(fixBatches[0]?.map((issue) => issue.description), ["must fix", "[manual] can wait"]);
});

test("reviewStep sends manual-only minor issues into applyFixes", async () => {
  const { orchestrator, specPath } = createOrchestrator();
  const anyOrchestrator = orchestrator as any;
  let fixCalls = 0;
  let calls = 0;
  let fixedIssues: ReviewIssue[] = [];
  anyOrchestrator.applyFixes = async (issues: ReviewIssue[]) => {
    fixCalls++;
    fixedIssues = issues;
  };

  const result = await anyOrchestrator.reviewStep(
    async () => {
      calls++;
      return calls >= 2
        ? { reviewer: "self_criteria", checklist: [], issues: [], isLgtm: true }
        : {
            reviewer: "self_criteria",
            checklist: [],
            issues: [minor("[manual] file-wide constant extraction")],
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
  assert.equal(fixCalls, 1);
  assert.deepEqual(fixedIssues.map((issue) => issue.description), ["[manual] file-wide constant extraction"]);
});

test("reviewStep applies fixes for manual major issues", async () => {
  const { orchestrator, specPath } = createOrchestrator();
  const anyOrchestrator = orchestrator as any;
  let fixCalls = 0;
  let calls = 0;
  let fixedIssues: ReviewIssue[] = [];
  anyOrchestrator.applyFixes = async (issues: ReviewIssue[]) => {
    fixCalls++;
    fixedIssues = issues;
  };

  const result = await anyOrchestrator.reviewStep(
    async () => {
      calls++;
      return calls >= 2
        ? { reviewer: "self_criteria", checklist: [], issues: [], isLgtm: true }
        : {
            reviewer: "self_criteria",
            checklist: [],
            issues: [major("[manual] changing validation order is required")],
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
  assert.equal(fixCalls, 1);
  assert.deepEqual(fixedIssues.map((issue) => issue.description), ["[manual] changing validation order is required"]);
});

test("reviewStep logs review_result summaries with findings detail", async () => {
  const { orchestrator, specPath, logger } = createOrchestrator();
  const anyOrchestrator = orchestrator as any;
  let calls = 0;
  anyOrchestrator.applyFixes = async () => {};
  const result = await anyOrchestrator.reviewStep(
    async () => {
      calls++;
      return calls >= 2
        ? { reviewer: "self_criteria", checklist: [], issues: [], isLgtm: true }
        : {
            reviewer: "self_criteria",
            checklist: [],
            issues: [major("must fix"), minor("[manual] can wait")],
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
      reviewStep: "criteria",
    },
  );

  assert.equal(result.isLgtm, true);
  const harnessEvents = readFileSync(join(logger.getLogDir(), "harness.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const reviewEvents = harnessEvents.filter((event) => event.event === EVENT.REVIEW_RESULT);
  assert.equal(reviewEvents.length, 2);
  assert.deepEqual(reviewEvents[0], {
    ts: reviewEvents[0].ts,
    event: EVENT.REVIEW_RESULT,
    step: "self_criteria",
    cycle: 1,
    reviewer: "self_criteria",
    issueCount: 2,
    severityCounts: { critical: 0, major: 1, minor: 1 },
    manualCount: 1,
    decision: "fixed",
    findings: [
      { severity: "major", description: "must fix" },
      { severity: "minor", description: "[manual] can wait" },
    ],
  });
  assert.deepEqual(reviewEvents[1], {
    ts: reviewEvents[1].ts,
    event: EVENT.REVIEW_RESULT,
    step: "self_criteria",
    cycle: 2,
    reviewer: "self_criteria",
    issueCount: 0,
    severityCounts: { critical: 0, major: 0, minor: 0 },
    manualCount: 0,
    decision: "lgtm",
    findings: [],
  });
});

test("parseFixPlan fails closed when repairs omit an issue", () => {
  const { orchestrator } = createOrchestrator();

  assert.throws(
    () => (orchestrator as any).parseFixPlan(JSON.stringify({
      summary: "fix selected issues",
      repairs: [{
        goal: "fix first issue",
        files: ["target.ts"],
        instructions: ["rename variable"],
        constraints: [],
        related_issues: [1],
      }],
      global_constraints: [],
    }), 2),
    HarnessError,
  );
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
  let executeRunCalls = 0;
  anyOrchestrator.executeRun = async (step: string, prompt: string) => {
    executeRunCalls++;
    runnerCalls.push({ prompt: `${step}:${prompt}` });
    if (executeRunCalls === 1) {
      return JSON.stringify({
        summary: "fix the reported issue",
        repairs: [{
          goal: "fix review issue",
          files: ["src/file.py"],
          instructions: ["update the reported code path"],
          constraints: ["do not change unrelated logic"],
          related_issues: [1],
        }],
        global_constraints: ["keep changes in scope"],
      });
    }
    return "";
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
  assert.equal(runnerCalls.some((call) => /修正計画/.test(call.prompt)), true);
  assert.equal(runnerCalls.some((call) => /related_issues: 1/.test(call.prompt)), true);
  assert.equal(runnerCalls.some((call) => /修正根拠は上の修正計画だけに限定する/.test(call.prompt)), true);
  assert.equal(runnerCalls.some((call) => /BLE001: blind except/.test(call.prompt)), true);
  assert.deepEqual(runnerCalls.at(-1)?.allowedTools, ["Write(src/*)"]);
});

test("applyFixes retries implementation fixes when post-fix tests fail", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-review-test-retry-"));
  const specPath = join(root, "spec.md");
  writeFileSync(specPath, "# spec\n", "utf-8");
  const logger = new HarnessLogger("review-test-retry", { baseDir: root });
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
  let runTestsCalls = 0;
  const lintGuard = {
    async check(_files: string[], options?: { claudeFix?: (violations: LintViolation[]) => Promise<void>; rescanFiles?: () => Promise<string[]> }) {
      lintCheckCalls++;
      await options?.rescanFiles?.();
    },
  } as any;

  const orchestrator = new ReviewOrchestrator(logger, lintGuard, root, registry);
  const anyOrchestrator = orchestrator as any;
  let executeRunCalls = 0;
  anyOrchestrator.executeRun = async (_step: string, prompt: string) => {
    executeRunCalls++;
    runnerCalls.push({ prompt });
    if (executeRunCalls === 1 || executeRunCalls === 3) {
      return JSON.stringify({
        summary: "fix the reported issue",
        repairs: [{
          goal: "fix review issue",
          files: ["src/file.py"],
          instructions: ["update the reported code path"],
          constraints: ["do not change unrelated logic"],
          related_issues: [1],
        }],
        global_constraints: ["keep changes in scope"],
      });
    }
    return "";
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
        return ["src/file.py"];
      },
      runTests: async () => {
        runTestsCalls++;
        if (runTestsCalls === 1) {
          throw new HarnessError("テスト失敗: assert recorded_triggers == ['startup']");
        }
      },
    },
  );

  assert.equal(runTestsCalls, 2);
  assert.equal(lintCheckCalls, 2);
  assert.equal(rescanCalls, 4);
  assert.equal(executeRunCalls, 4);
  assert.equal(runnerCalls.some((call) => /apply_fixes の再試行 2\/3/.test(call.prompt)), true);
  assert.equal(runnerCalls.some((call) => /直前のテスト失敗/.test(call.prompt)), true);
  assert.equal(runnerCalls.some((call) => /テストコードや期待結果は変更しない/.test(call.prompt)), true);
  const harnessEvents = readFileSync(join(logger.getLogDir(), "harness.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const applyFixTestRuns = harnessEvents.filter((event) => event.event === EVENT.TEST_RUN && event.phase === "apply_fixes");
  assert.deepEqual(
    applyFixTestRuns.map((event) => ({
      reviewStep: event.reviewStep,
      attempt: event.attempt,
      result: event.result,
    })),
    [
      { reviewStep: "unknown", attempt: 1, result: "FAILED" },
      { reviewStep: "unknown", attempt: 2, result: "GREEN" },
    ],
  );
});
