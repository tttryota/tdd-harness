import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuardError, HarnessError } from "../../domain/model/types.ts";
import { Boundary } from "../../domain/services/boundary.ts";
import { parseImplGenerationResult, parseTestGenerationResult, ImplFlow } from "./impl-flow.ts";
import { DefaultFlowRuntimeFactory } from "../../infrastructure/runtime/default-flow-runtime-factory.ts";
import { LauncherToolExecutor } from "../../infrastructure/process/launcher-tool-executor.ts";
import { buildValidatedImplPlan } from "../plan/validated-plan.ts";
import { resolveCriteriaPaths } from "../resolvers/criteria-resolver.ts";
import { buildMswInstructions, resolveRuleName, resolveRulesContent } from "../resolvers/rules-resolver.ts";

test("parseTestGenerationResult accepts noop result", () => {
  const result = parseTestGenerationResult(JSON.stringify({
    decision: "noop",
    why: ["covered by existing tests"],
    covered_test_cases: ["case 1", "case 2"],
    updated_test_cases: [],
    notes: [],
  }));

  assert.equal(result.decision, "noop");
  assert.deepEqual(result.coveredTestCases, ["case 1", "case 2"]);
});

test("parseTestGenerationResult accepts updated result", () => {
  const result = parseTestGenerationResult(JSON.stringify({
    decision: "updated",
    why: ["case 3 was missing"],
    covered_test_cases: ["case 1", "case 2", "case 3"],
    updated_test_cases: ["case 3"],
    notes: ["added a direct assertion"],
  }));

  assert.equal(result.decision, "updated");
  assert.deepEqual(result.updatedTestCases, ["case 3"]);
});

test("parseTestGenerationResult accepts contract revision result", () => {
  const result = parseTestGenerationResult(JSON.stringify({
    decision: "contract_revision_required",
    why: ["dependency protocol signature is underdetermined"],
    covered_test_cases: ["case 1"],
    updated_test_cases: [],
    notes: ["DiffDetector.detect(target_path, snapshot_store) signature is not defined"],
  }));

  assert.equal(result.decision, "contract_revision_required");
  assert.deepEqual(result.notes, ["DiffDetector.detect(target_path, snapshot_store) signature is not defined"]);
});

test("parseImplGenerationResult accepts noop result", () => {
  const result = parseImplGenerationResult(JSON.stringify({
    decision: "noop",
    why: ["existing implementation already satisfies spec and tests"],
    covered_requirements: ["requirement 1", "requirement 2"],
    updated_requirements: [],
    notes: [],
  }));

  assert.equal(result.decision, "noop");
  assert.deepEqual(result.coveredRequirements, ["requirement 1", "requirement 2"]);
});

test("parseImplGenerationResult accepts updated result", () => {
  const result = parseImplGenerationResult(JSON.stringify({
    decision: "updated",
    why: ["implemented missing boundary handling"],
    covered_requirements: ["requirement 1", "requirement 2", "requirement 3"],
    updated_requirements: ["requirement 3"],
    notes: ["kept the existing interface unchanged"],
  }));

  assert.equal(result.decision, "updated");
  assert.deepEqual(result.updatedRequirements, ["requirement 3"]);
});

test("impl generation result parsers fail closed on malformed payloads", () => {
  assert.throws(() => parseTestGenerationResult("not-json"), HarnessError);
  assert.throws(
    () => parseTestGenerationResult(JSON.stringify({ decision: "bad", why: [], covered_test_cases: [], updated_test_cases: [], notes: [] })),
    /decision が不正/,
  );
  assert.throws(
    () => parseImplGenerationResult(JSON.stringify({ decision: "noop", why: [1], covered_requirements: [], updated_requirements: [], notes: [] })),
    /why が不正/,
  );
});

test("ImplFlow helper methods resolve criteria, rules, and MSW instructions", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-impl-helpers-"));
  mkdirSync(join(root, ".harness", "resources", "criteria"), { recursive: true });
  mkdirSync(join(root, ".harness", "resources", "rules"), { recursive: true });
  mkdirSync(join(root, "docs", "spec", "quiz"), { recursive: true });
  mkdirSync(join(root, "tests", "test-cases", "quiz"), { recursive: true });
  writeFileSync(join(root, ".harness", "resources", "criteria", "review-criteria-common.md"), "# common\n", "utf-8");
  writeFileSync(join(root, ".harness", "resources", "criteria", "review-criteria-backend.md"), "# backend\n", "utf-8");
  writeFileSync(join(root, ".harness", "resources", "criteria", "review-criteria-frontend.md"), "# frontend\n", "utf-8");
  writeFileSync(join(root, ".harness", "resources", "rules", "impl.md"), "# impl rules\n", "utf-8");
  writeFileSync(join(root, ".harness", "resources", "rules", "logic.md"), "# logic rules\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "result.md"), "---\nstatus: approved\n---\n", "utf-8");
  writeFileSync(join(root, "tests", "test-cases", "quiz", "result.md"), "---\nstatus: approved\n---\n", "utf-8");

  const profile = {
    reviewCriteria: [],
    criteriaPreset: undefined,
    sourceLayout: {
      sourceDir: "backend/{{category}}",
      testDir: "backend/{{category}}/tests",
      scopePattern: "backend/{{category}}/*",
      additionalAllowedPrefixes: [".harness/reviews/"],
    },
  } as any;
  const boundary = new Boundary(root, profile.sourceLayout, ["ts"], []);
  const flow = new ImplFlow(boundary, {} as never, profile, {} as never, [], new DefaultFlowRuntimeFactory(), new LauncherToolExecutor());
  const validatedPlan = buildValidatedImplPlan(boundary, {
    type: "impl",
    profile: "frontend",
    scope: "orders/create",
    specPath: "docs/spec/quiz/result.md",
    testCasesPath: "tests/test-cases/quiz/result.md",
    msw: true,
    description: "impl",
    targets: [],
    dependencies: [],
    browserScenarios: [],
    targetTestCases: ["case 1"],
    exclusions: [],
    completionCriteria: [],
    designDecisions: [],
  } as any);

  assert.equal((flow as any).shouldSkip(null, "impl_generate"), false);
  assert.equal((flow as any).shouldSkip("impl_generate", "test_generate"), true);
  assert.deepEqual(resolveCriteriaPaths({
    projectRoot: root,
    explicitCriteria: profile.reviewCriteria,
    criteriaPreset: profile.criteriaPreset,
    defaultFallbackNames: ["review-criteria-common", "review-criteria-backend"],
  }).paths, [
    join(root, ".harness", "resources", "criteria", "review-criteria-common.md"),
    join(root, ".harness", "resources", "criteria", "review-criteria-backend.md"),
  ]);
  assert.match(resolveRulesContent(root, resolveRuleName("impl", "backend")).content, /impl rules/);
  assert.match(resolveRulesContent(root, resolveRuleName(validatedPlan.type, validatedPlan.profile)).content, /logic rules/);
  assert.equal(resolveRuleName("component", "frontend"), "component");
  assert.match(buildMswInstructions(true, "test"), /MSW セットアップ/);
  assert.match(buildMswInstructions(true, "impl"), /MSW ハンドラ生成/);
  assert.equal(buildMswInstructions(false, "impl"), "");
});

test("ImplFlow resolveCriteriaPaths rejects missing explicit criteria files", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-impl-criteria-missing-"));
  const profile = {
    reviewCriteria: ["missing.md"],
    criteriaPreset: undefined,
    sourceLayout: {
      sourceDir: "backend/{{category}}",
      testDir: "backend/{{category}}/tests",
      scopePattern: "backend/{{category}}/*",
      additionalAllowedPrefixes: [".harness/reviews/"],
    },
  } as any;
  const boundary = new Boundary(root, profile.sourceLayout, ["ts"], []);
  assert.throws(() => resolveCriteriaPaths({
    projectRoot: root,
    explicitCriteria: profile.reviewCriteria,
    criteriaPreset: profile.criteriaPreset,
    defaultFallbackNames: ["review-criteria-common", "review-criteria-backend"],
  }), GuardError);
});

test("ImplFlow reviews only changed test and implementation files", async () => {
  const changedTestFile = "/tmp/test_file_diff_detector.py";
  const changedImplFile = "/tmp/file_diff_detector.py";
  const calls: any[] = [];
  const boundary = {
    getProjectRoot: () => "/tmp",
    findChangedTestFiles: async () => [changedTestFile],
    findChangedImplementationFiles: async () => [changedImplFile],
    testAllowedTools: () => ["Read"],
    implAllowedTools: () => ["Read"],
  } as any;
  const flow = new ImplFlow(boundary, {} as never, {} as never, {} as never, [], new DefaultFlowRuntimeFactory(), new LauncherToolExecutor());
  const orchestrator = {
    runReview: async (params: any) => {
      calls.push(params);
      return [];
    },
  } as any;
  const plan = {
    scope: "ingestion/file-diff-detector",
    resolvedPaths: {
      specPath: "/tmp/spec.md",
      testCasesPath: "/tmp/cases.md",
    },
    targetTestCases: ["TC-01"],
  } as any;

  await (flow as any).runTestReview(orchestrator, plan, "backend/core/ingestion/infrastructure");
  await (flow as any).runImplReview(orchestrator, plan, ["/tmp/criteria.md"], "backend/core/ingestion/infrastructure");

  assert.deepEqual(calls[0].targetFiles, [changedTestFile]);
  assert.deepEqual(await calls[0].rescanFiles(), [changedTestFile]);
  assert.deepEqual(calls[1].targetFiles, [changedImplFile]);
  assert.deepEqual(await calls[1].rescanFiles(), [changedImplFile]);
});

test("ImplFlow resume skips completed implementation review phases", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-impl-resume-"));
  mkdirSync(join(root, ".harness", "resources", "criteria"), { recursive: true });
  writeFileSync(join(root, ".harness", "resources", "criteria", "review-criteria-common.md"), "# common\n", "utf-8");
  writeFileSync(join(root, ".harness", "resources", "criteria", "review-criteria-backend.md"), "# backend\n", "utf-8");
  writeFileSync(join(root, "spec.md"), "---\nstatus: approved\n---\n# spec\n", "utf-8");
  writeFileSync(join(root, "cases.md"), "---\nstatus: approved\n---\n# cases\n", "utf-8");
  const reviewCalls: string[] = [];
  const savedSteps: string[] = [];
  const logger = {
    log() {},
    logCommand() {},
    logTranscript() {},
    saveReviewData() {},
    saveCheckpoint(data: { completedStep: string }) {
      savedSteps.push(data.completedStep);
    },
    loadCheckpoint() {
      return {
        planPath: "plan.md",
        completedStep: "impl_review_criteria_passed",
        sessionId: "sess-1",
        testGenerationDecision: "updated",
        records: [],
        greenAttempt: 2,
        timestamp: "now",
      };
    },
    clearCheckpoint() {},
    summarizeRunnerUsage() {
      return { total: { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, byStep: {} };
    },
  };
  const reviewOrchestrator = {
    restoreRecords() {},
    getRecords() { return []; },
    runImplementationCriteriaReview: async () => { reviewCalls.push("criteria"); return {}; },
    runImplementationQualityReview: async () => { reviewCalls.push("quality"); return {}; },
    runImplementationExternalReview: async () => { reviewCalls.push("external"); return {}; },
  };
  const runtimeFactory = {
    createImplRuntime() {
      return {
        logger,
        lintGuard: {} as any,
        reviewOrchestrator,
        driftGuard: { startTask() {}, checkTimeout() {}, checkDiffScope() {}, recordTestAttempt() { return null; } },
      };
    },
  } as any;
  const boundary = {
    getProjectRoot: () => root,
    implementationGuard() {},
    validateScope() {},
    extractCategory() { return "ingestion"; },
    extractName() { return "chunk"; },
    assertWithinProject() {},
    readFrontmatter() { return {}; },
    testPathForScope: () => "backend/ingestion/tests",
    scopeAllowedTools: () => ["Read"],
    testAllowedTools: () => ["Read"],
    implAllowedTools: () => ["Read"],
    findChangedImplementationFiles: async () => [join(root, "chunk.ts")],
    findChangedTestFiles: async () => [],
    findSourceFiles: async () => [],
    findImplementationFiles: async () => [join(root, "chunk.ts")],
    findTestFiles: async () => [],
    findMisplacedTestFiles: async () => [],
    stageFiles: async () => {},
    verifyChangedFilesWithinScope: async () => {},
    getCurrentCommitHash: async () => "",
    countDiffLines: async () => 0,
    countDiffLinesForFiles: async () => 0,
    getFileDiff: async () => "",
  } as any;
  const flow = new ImplFlow(boundary, {
    getConfig() { return { runners: {}, templates: {} }; },
    getStepMapping() { return {}; },
    isStepSkipped() { return false; },
    getRunner() { throw new Error("should not run generation on resume"); },
  } as any, {
    toolRoot: root,
    exec: [],
    reviewCriteria: [],
    criteriaPreset: "backend",
  } as any, {
    frameworkName: "fake",
    buildArgs() { return []; },
    parseResult() { return { kind: "passed", output: "" }; },
  } as any, [], runtimeFactory, new LauncherToolExecutor());

  await (flow as any).run("plan.md", {
    resume: true,
    plan: {
      type: "impl",
      profile: "backend",
      scope: "ingestion/chunk",
      specPath: join(root, "spec.md"),
      testCasesPath: join(root, "cases.md"),
      description: "impl",
      targets: [],
      dependencies: [],
      browserScenarios: [],
      targetTestCases: ["case"],
      exclusions: [],
      completionCriteria: [],
      designDecisions: ["decision"],
    },
  });

  assert.deepEqual(reviewCalls, ["quality", "external"]);
  assert.deepEqual(savedSteps, ["impl_review_quality_passed", "impl_reviewed"]);
});

test("ImplFlow stops when test generation requires contract revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-impl-contract-revision-"));
  mkdirSync(join(root, "docs", "spec"), { recursive: true });
  mkdirSync(join(root, "tests", "test-cases"), { recursive: true });
  writeFileSync(join(root, "docs", "spec", "feature.md"), "---\nstatus: approved\n---\n# spec\n", "utf-8");
  writeFileSync(join(root, "tests", "test-cases", "feature.md"), "---\nstatus: approved\n---\n# cases\n", "utf-8");

  const checkpoints: Array<{ completedStep: string; testGenerationDecision?: string }> = [];
  const reviewDataPayloads: unknown[] = [];
  const logger = {
    log() {},
    logCommand() {},
    logTranscript() {},
    saveReviewData(data: unknown) { reviewDataPayloads.push(data); },
    saveCheckpoint(data: { completedStep: string; testGenerationDecision?: string }) { checkpoints.push(data); },
    loadCheckpoint() { return null; },
    clearCheckpoint() {},
    summarizeRunnerUsage() {
      return { total: { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, byStep: {} };
    },
  };
  const runtimeFactory = {
    createImplRuntime() {
      return {
        logger,
        lintGuard: { check: async () => {} },
        reviewOrchestrator: { getRecords() { return []; }, restoreRecords() {} },
        driftGuard: { startTask() {}, checkTimeout() {}, checkDiffScope() {}, recordTestAttempt() { return null; } },
      };
    },
  } as any;
  const boundary = {
    getProjectRoot: () => root,
    implementationGuard() {},
    validateScope() {},
    readFrontmatter() { return {}; },
    testPathForScope: () => "tests",
    scopeAllowedTools: () => ["Read"],
    testAllowedTools: () => ["Read"],
    implAllowedTools: () => ["Read"],
    findChangedImplementationFiles: async () => [],
    findChangedTestFiles: async () => [],
    findSourceFiles: async () => [],
    findImplementationFiles: async () => [],
    findTestFiles: async () => [],
    findMisplacedTestFiles: async () => [],
    stageFiles: async () => {},
    verifyChangedFilesWithinScope: async () => {},
    getCurrentCommitHash: async () => "",
    countDiffLines: async () => 0,
    countDiffLinesForFiles: async () => 0,
    getFileDiff: async () => "",
    extractCategory() { return "core"; },
    extractName() { return "feature"; },
    assertWithinProject() {},
  } as any;
  const registry = {
    getConfig() { return { runners: {}, templates: {} }; },
    getStepMapping() { return {}; },
    isStepSkipped() { return false; },
    getRunner() {
      return {
        async run() {
          return {
            text: JSON.stringify({
              decision: "contract_revision_required",
              why: ["signature is underdetermined"],
              covered_test_cases: ["case"],
              updated_test_cases: [],
              notes: ["Tagger.tag(batch_input) contract is missing"],
            }),
            sessionId: "sess-1",
          };
        },
      };
    },
  } as any;
  const flow = new ImplFlow(boundary, registry, {
    toolRoot: root,
    exec: [],
    reviewCriteria: [],
    criteriaPreset: "backend",
  } as any, {
    frameworkName: "fake",
    buildArgs() { return []; },
    parseResult() { return { kind: "passed", output: "" }; },
    name: "fake",
  } as any, [], runtimeFactory, new LauncherToolExecutor());

  await assert.rejects(
    () => (flow as any).run("plan.md", {
      plan: {
        type: "impl",
        profile: "backend",
        scope: "feature",
        specPath: "docs/spec/feature.md",
        testCasesPath: "tests/test-cases/feature.md",
        description: "impl",
        targets: [],
        dependencies: [],
        browserScenarios: [],
        targetTestCases: ["case"],
        exclusions: [],
        completionCriteria: [],
        designDecisions: [],
      },
    }),
    /契約定義見直しが必要/,
  );

  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0]?.completedStep, "test_generated");
  assert.equal(checkpoints[0]?.testGenerationDecision, "contract_revision_required");
  assert.equal((reviewDataPayloads[0] as any)?.status, "failed");
  assert.match((reviewDataPayloads[0] as any)?.error?.message ?? "", /契約定義見直しが必要/);
});
