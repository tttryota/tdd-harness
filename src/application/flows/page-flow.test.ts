import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Boundary } from "../../domain/services/boundary.ts";
import { PageFlow } from "./page-flow.ts";
import { FLOW_STEP } from "../../domain/model/steps.ts";
import { GuardError, HarnessError } from "../../domain/model/types.ts";
import type { FlowRuntimeFactory, PageFlowRuntime } from "../ports/flow-runtime-factory.ts";
import type { ToolExecutor } from "../ports/tool-executor.ts";
import type { Logger } from "../ports/logger.ts";
import { buildValidatedPagePlan } from "../plan/validated-plan.ts";
import { browserIssuesFromResult } from "../policies/review-issue-policy.ts";
import { resolveCriteriaPaths } from "../resolvers/criteria-resolver.ts";

function initGitRepo(root: string): void {
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Codex"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root });
}

function makeProfile(root: string) {
  return {
    toolRoot: root,
    exec: [],
    reviewCriteria: [],
    criteriaPreset: "frontend",
    sourceLayout: {
      sourceDir: "frontend/src/{{category}}/{{name}}",
      testDir: "frontend/src/{{category}}/{{name}}/__tests__",
      scopePattern: "frontend/src/{{category}}/{{name}}/*",
      additionalAllowedPrefixes: [".harness/reviews/", ".harness/logs/"],
    },
  } as any;
}

function fakeTestAdapter() {
  return {
    name: "node",
    frameworkName: "fake",
    fileExtensions: ["ts", "tsx"],
    excludeDirs: [],
    buildArgs(testPath: string) {
      return [
        "-e",
        "const fs=require('node:fs');const path=require('node:path');const target=process.argv[1];const collect=(p)=>fs.statSync(p).isDirectory()?fs.readdirSync(p).flatMap((name)=>collect(path.join(p,name))):[fs.readFileSync(p,'utf-8')];const text=collect(target).join('\\n');process.exit(text.includes('PASS')?0:1);",
        testPath,
      ];
    },
    parseResult(stdout: string, stderr: string, exitCode: number) {
      const output = stdout + stderr;
      return exitCode === 0
        ? { kind: "passed", output, exitCode }
        : { kind: "failed", output, exitCode };
    },
  } as any;
}

function fakeLogger(): Logger {
  return {
    log() {},
    logCommand() {},
    logTranscript() {},
    saveReviewData() {},
    saveCheckpoint() {},
    loadCheckpoint() { return null; },
    clearCheckpoint() {},
    summarizeRunnerUsage() {
      return { total: { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, byStep: {} };
    },
  };
}

function pageRuntimeFactory(runtimeOverrides?: Partial<PageFlowRuntime>) {
  const runtime: PageFlowRuntime = {
    logger: fakeLogger(),
    lintGuard: { async check() {} } as any,
    reviewOrchestrator: { async runPageReview() {} } as any,
    ...runtimeOverrides,
  };
  const factory: FlowRuntimeFactory = {
    createPageRuntime() { return runtime; },
    createComponentRuntime() { throw new Error("unexpected component runtime"); },
    createImplRuntime() { throw new Error("unexpected impl runtime"); },
  };
  return { runtime, factory };
}

function toolExecutor(handler?: ToolExecutor["run"]): ToolExecutor {
  return {
    async run(toolName, args, options) {
      if (handler) return handler(toolName, args, options);
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

test("PageFlow runs a happy path page implementation via injected runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-page-flow-"));
  mkdirSync(join(root, "frontend", "src", "quiz", "result", "__tests__"), { recursive: true });
  mkdirSync(join(root, "docs", "spec", "quiz"), { recursive: true });
  mkdirSync(join(root, "tests", "test-cases", "quiz"), { recursive: true });
  writeFileSync(join(root, "docs", "spec", "quiz", "result.md"), "---\nstatus: approved\n---\n", "utf-8");
  writeFileSync(join(root, "tests", "test-cases", "quiz", "result.md"), "---\nstatus: approved\n---\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "components.md"), "---\nstatus: approved\n---\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "figma.json"), "{}", "utf-8");
  initGitRepo(root);

  const profile = makeProfile(root);
  const boundary = new Boundary(root, profile.sourceLayout, ["ts", "tsx"], []);
  const lintChecks: string[][] = [];
  const pageReviews: unknown[] = [];
  const { factory } = pageRuntimeFactory({
    lintGuard: {
      async check(files: string[]) {
        lintChecks.push(files);
      },
    } as any,
    reviewOrchestrator: {
      async runPageReview(params: unknown) {
        pageReviews.push(params);
      },
    } as any,
  });
  const registry = {
    getConfig() {
      return { templates: {} };
    },
    getRunner(step: string) {
      return {
        async run() {
          if (step === FLOW_STEP.PAGE_GENERATE) {
            writeFileSync(join(root, "frontend", "src", "quiz", "result", "ResultPage.tsx"), "export const ResultPage = () => null;\n", "utf-8");
            writeFileSync(join(root, "frontend", "src", "quiz", "result", "__tests__", "ResultPage.test.ts"), "PASS\n", "utf-8");
          }
          if (step === FLOW_STEP.PAGE_BROWSER_VERIFY) {
            return { text: "{\"overall\":\"pass\",\"scenarios\":[{\"name\":\"score\",\"status\":\"pass\"}]}" };
          }
          return {
            text: "{\"checklist\":[{\"item\":\"ok\",\"verdict\":\"pass\",\"evidence\":\"done\"}],\"issues\":[]}",
          };
        },
      };
    },
  } as any;
  const flow = new PageFlow(boundary, registry, profile, fakeTestAdapter(), [], factory, toolExecutor());
  const plan = {
    type: "page",
    profile: "frontend",
    scope: "quiz/result",
    specPath: "docs/spec/quiz/result.md",
    testCasesPath: "tests/test-cases/quiz/result.md",
    componentSpecPath: "docs/spec/quiz/components.md",
    figmaCachePath: "docs/spec/quiz/figma.json",
    msw: false,
    description: "page",
    targets: [],
    dependencies: [{ name: "dep", importPath: "@/dep" }],
    figmaSlice: "slice",
    browserScenarios: [{ name: "score", objective: "show", route: "/r", preconditions: [], steps: ["open"], expect: ["see"] }],
    targetTestCases: ["shows result"],
    exclusions: [],
    completionCriteria: ["works"],
    designDecisions: [],
  } as any;

  await flow.run("plan.md", { plan });

  assert.match(readFileSync(join(root, "frontend", "src", "quiz", "result", "ResultPage.tsx"), "utf-8"), /ResultPage/);
  assert.equal(lintChecks.length, 1);
  assert.equal(pageReviews.length, 1);
  const parsed = (flow as any).parseBrowserVerificationResult("```json\n{\"overall\":\"blocked\",\"scenarios\":[{\"name\":\"score\",\"status\":\"blocked\"}]}\n```");
  assert.equal(parsed.overall, "blocked");
});

test("PageFlow validates plan requirements and review criteria resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-page-validate-"));
  mkdirSync(join(root, "frontend", "src", "quiz", "result", "__tests__"), { recursive: true });
  mkdirSync(join(root, "docs", "spec", "quiz"), { recursive: true });
  mkdirSync(join(root, "tests", "test-cases", "quiz"), { recursive: true });
  mkdirSync(join(root, ".harness", "resources", "criteria"), { recursive: true });
  writeFileSync(join(root, ".harness", "resources", "criteria", "review-criteria-common.md"), "# common\n", "utf-8");
  writeFileSync(join(root, ".harness", "resources", "criteria", "review-criteria-frontend.md"), "# frontend\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "result.md"), "---\nstatus: approved\n---\n", "utf-8");
  writeFileSync(join(root, "tests", "test-cases", "quiz", "result.md"), "---\nstatus: approved\n---\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "components.md"), "---\nstatus: approved\n---\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "figma.json"), "{}", "utf-8");
  initGitRepo(root);

  const profile = makeProfile(root);
  profile.reviewCriteria = [".harness/resources/criteria/review-criteria-common.md"];
  const boundary = new Boundary(root, profile.sourceLayout, ["ts", "tsx"], []);
  const flow = new PageFlow(boundary, {
    getConfig() {
      return { templates: {} };
    },
  } as any, profile, fakeTestAdapter(), [], pageRuntimeFactory().factory, toolExecutor());

  const validPlan = {
    type: "page",
    profile: "frontend",
    scope: "quiz/result",
    specPath: "docs/spec/quiz/result.md",
    testCasesPath: "tests/test-cases/quiz/result.md",
    componentSpecPath: "docs/spec/quiz/components.md",
    figmaCachePath: "docs/spec/quiz/figma.json",
    msw: false,
    description: "page",
    targets: [],
    dependencies: [{ name: "dep", importPath: "@/dep" }],
    figmaSlice: "slice",
    browserScenarios: [{ name: "score", objective: "show", route: "/r", preconditions: [], steps: ["open"], expect: ["see"] }],
    targetTestCases: ["shows result"],
    exclusions: [],
    completionCriteria: ["works"],
    designDecisions: [],
  } as any;

  assert.equal(resolveCriteriaPaths({
    projectRoot: root,
    explicitCriteria: profile.reviewCriteria,
    criteriaPreset: profile.criteriaPreset,
    defaultFallbackNames: ["review-criteria-common", "review-criteria-frontend"],
  }).paths.length, 3);

  const missingScenarioPlan = { ...validPlan, browserScenarios: [] };
  assert.throws(() => buildValidatedPagePlan(boundary, missingScenarioPlan), GuardError);

  const pendingSpecPlan = { ...validPlan, specPath: "docs/spec/quiz/pending.md" };
  writeFileSync(join(root, "docs", "spec", "quiz", "pending.md"), "---\nstatus: draft\n---\n", "utf-8");
  assert.throws(() => buildValidatedPagePlan(boundary, pendingSpecPlan), /仕様書が ready ではありません/);

  const requiredFieldCases = [
    { patch: { profile: "" }, pattern: /profile が必要/ },
    { patch: { scope: "" }, pattern: /scope が必要/ },
    { patch: { specPath: "" }, pattern: /spec が必要/ },
    { patch: { testCasesPath: "" }, pattern: /test_cases が必要/ },
    { patch: { componentSpecPath: "" }, pattern: /component_spec が必要/ },
    { patch: { figmaCachePath: "" }, pattern: /figma_cache が必要/ },
    { patch: { msw: undefined }, pattern: /msw が必要/ },
    { patch: { dependencies: [] }, pattern: /Dependencies セクション/ },
    { patch: { figmaSlice: "" }, pattern: /Figma Slice セクション/ },
    { patch: { targetTestCases: [] }, pattern: /対象テストケース セクション/ },
    { patch: { completionCriteria: [] }, pattern: /完了条件 セクション/ },
  ];
  for (const entry of requiredFieldCases) {
    assert.throws(() => buildValidatedPagePlan(boundary, { ...validPlan, ...entry.patch }), entry.pattern);
  }
});

test("PageFlow browser parsing and issue conversion fail closed on invalid payloads", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-page-browser-parse-"));
  const profile = makeProfile(root);
  const boundary = new Boundary(root, profile.sourceLayout, ["ts", "tsx"], []);
  const flow = new PageFlow(boundary, { getConfig() { return { templates: {} }; } } as any, profile, fakeTestAdapter(), [], pageRuntimeFactory().factory, toolExecutor());

  const parsed = (flow as any).parseBrowserVerificationResult("{\"overall\":\"fail\",\"scenarios\":[{\"name\":\"score\",\"status\":\"fail\",\"expected\":[\"a\"],\"observed\":[\"b\"],\"failed_step\":\"click\"}]}");
  assert.equal(parsed.scenarios[0].failedStep, "click");
  assert.equal(browserIssuesFromResult(parsed)[0].severity, "major");
  assert.equal(
    browserIssuesFromResult({ overall: "blocked", scenarios: [] })[0].severity,
    "critical",
  );
  assert.deepEqual((flow as any).optionalStringList(["a", 1, "b"]), ["a", "b"]);
  assert.equal((flow as any).optionalString(" "), undefined);
  assert.throws(() => (flow as any).parseBrowserVerificationResult("not-json"), HarnessError);
  assert.throws(
    () => (flow as any).parseBrowserVerificationResult("{\"overall\":\"maybe\",\"scenarios\":[]}"),
    /overall は pass\/fail\/blocked/,
  );
  assert.throws(
    () => (flow as any).parseBrowserVerificationResult("{\"overall\":\"pass\",\"scenarios\":[{\"name\":\"score\",\"status\":\"maybe\"}]}"),
    /status は pass\/fail\/blocked/,
  );
  assert.throws(() => (flow as any).requiredString("", "name"), /空でない文字列/);
});

test("PageFlow runTests distinguishes failures from harness-level guard errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-page-tests-"));
  mkdirSync(join(root, "frontend", "src", "quiz", "result", "__tests__"), { recursive: true });
  const profile = makeProfile(root);
  const boundary = new Boundary(root, profile.sourceLayout, ["ts", "tsx"], []);
  const flow = new PageFlow(boundary, { getConfig() { return { templates: {} }; } } as any, profile, {
    name: process.execPath,
    frameworkName: "synthetic",
    fileExtensions: ["ts"],
    excludeDirs: [],
    buildArgs() {
      return ["-e", "process.stdout.write('bad suite')"];
    },
    parseResult() {
      return { kind: "collection-error", output: "bad suite" };
    },
  } as any, [], pageRuntimeFactory().factory, toolExecutor(async () => ({ stdout: "bad suite", stderr: "", exitCode: 0 })));

  await assert.rejects(() => (flow as any).runTests("frontend/src/quiz/result/__tests__"), GuardError);
});

test("PageFlow generatePage, browser verification, and browser fixes build contract-bearing requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-page-prompts-"));
  mkdirSync(join(root, "frontend", "src", "quiz", "result"), { recursive: true });
  mkdirSync(join(root, "docs", "spec", "quiz"), { recursive: true });
  mkdirSync(join(root, ".harness", "resources", "criteria"), { recursive: true });
  writeFileSync(join(root, ".harness", "resources", "criteria", "review-criteria-common.md"), "# common\n", "utf-8");
  writeFileSync(join(root, ".harness", "resources", "criteria", "review-criteria-frontend.md"), "# frontend\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "result.md"), "---\nstatus: approved\n---\n# spec\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "components.md"), "---\nstatus: approved\n---\n# component\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "figma.json"), "{}", "utf-8");
  writeFileSync(join(root, "frontend", "src", "quiz", "result", "ResultPage.tsx"), "export const ResultPage = () => null;\n", "utf-8");

  const requests = new Map<string, { prompt: string; allowedTools?: string[] }>();
  const profile = makeProfile(root);
  profile.reviewCriteria = [];
  const boundary = new Boundary(root, profile.sourceLayout, ["ts", "tsx"], []);
  const registry = {
    getConfig() {
      return { templates: {} };
    },
    getRunner(step: string) {
      return {
        async run(request: { prompt: string; allowedTools?: string[] }) {
          requests.set(step, request);
          if (step === FLOW_STEP.PAGE_BROWSER_VERIFY) {
            return { text: "{\"overall\":\"fail\",\"scenarios\":[{\"name\":\"score\",\"status\":\"fail\",\"expected\":[\"show\"],\"observed\":[\"blank\"]}]}" };
          }
          return { text: "ok" };
        },
      };
    },
  } as any;
  const flow = new PageFlow(boundary, registry, profile, fakeTestAdapter(), [], pageRuntimeFactory().factory, toolExecutor());
  const plan = {
    type: "page",
    profile: "frontend",
    scope: "quiz/result",
    specPath: "docs/spec/quiz/result.md",
    testCasesPath: "tests/test-cases/quiz/result.md",
    componentSpecPath: "docs/spec/quiz/components.md",
    figmaCachePath: "docs/spec/quiz/figma.json",
    msw: false,
    description: "page",
    targets: [],
    dependencies: [{ name: "QuizCard", importPath: "@/components/QuizCard" }],
    figmaSlice: "slice",
    browserScenarios: [{ name: "score", objective: "show", route: "/r", preconditions: [], steps: ["open"], expect: ["see"] }],
    targetTestCases: ["shows score"],
    exclusions: [],
    completionCriteria: ["works"],
    designDecisions: ["keep state local"],
  } as any;
  mkdirSync(join(root, "tests", "test-cases", "quiz"), { recursive: true });
  writeFileSync(join(root, "tests", "test-cases", "quiz", "result.md"), "---\nstatus: approved\n---\n# tests\n", "utf-8");
  const validatedPlan = buildValidatedPagePlan(boundary, plan);

  await (flow as any).generatePage(validatedPlan, ["Read"]);
  const browserResult = await (flow as any).runBrowserVerification(validatedPlan, [join(root, "frontend", "src", "quiz", "result", "ResultPage.tsx")]);
  await (flow as any).applyBrowserFixes(browserIssuesFromResult(browserResult), ["Write(frontend/src/quiz/result/*)"]);

  assert.equal(browserResult.overall, "fail");
  assert.match(requests.get(FLOW_STEP.PAGE_GENERATE)?.prompt ?? "", /# spec/);
  assert.match(requests.get(FLOW_STEP.PAGE_GENERATE)?.prompt ?? "", /# component/);
  assert.match(requests.get(FLOW_STEP.PAGE_GENERATE)?.prompt ?? "", /QuizCard/);
  assert.match(requests.get(FLOW_STEP.PAGE_GENERATE)?.prompt ?? "", /score/);
  assert.deepEqual(requests.get(FLOW_STEP.PAGE_GENERATE)?.allowedTools, ["Read"]);
  assert.match(requests.get(FLOW_STEP.PAGE_BROWSER_VERIFY)?.prompt ?? "", /ResultPage/);
  assert.match(requests.get(FLOW_STEP.PAGE_BROWSER_VERIFY)?.prompt ?? "", /score/);
  assert.match(requests.get(FLOW_STEP.APPLY_FIXES)?.prompt ?? "", /expected=show/);
  assert.match(requests.get(FLOW_STEP.APPLY_FIXES)?.prompt ?? "", /observed=blank/);
  assert.deepEqual(requests.get(FLOW_STEP.APPLY_FIXES)?.allowedTools, ["Write(frontend/src/quiz/result/*)"]);
});

test("PageFlow retries after a browser verification failure and returns on the second pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-page-retry-"));
  mkdirSync(join(root, "frontend", "src", "quiz", "result", "__tests__"), { recursive: true });
  mkdirSync(join(root, "docs", "spec", "quiz"), { recursive: true });
  mkdirSync(join(root, "tests", "test-cases", "quiz"), { recursive: true });
  writeFileSync(join(root, "docs", "spec", "quiz", "result.md"), "---\nstatus: approved\n---\n", "utf-8");
  writeFileSync(join(root, "tests", "test-cases", "quiz", "result.md"), "---\nstatus: approved\n---\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "components.md"), "---\nstatus: approved\n---\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "figma.json"), "{}", "utf-8");
  initGitRepo(root);

  const profile = makeProfile(root);
  const boundary = new Boundary(root, profile.sourceLayout, ["ts", "tsx"], []);
  let browserRuns = 0;
  let applyFixRuns = 0;
  const registry = {
    getConfig() {
      return { templates: {} };
    },
    getRunner(step: string) {
      return {
        async run() {
          if (step === FLOW_STEP.PAGE_GENERATE) {
            writeFileSync(join(root, "frontend", "src", "quiz", "result", "ResultPage.tsx"), "export const ResultPage = () => null;\n", "utf-8");
            writeFileSync(join(root, "frontend", "src", "quiz", "result", "__tests__", "ResultPage.test.ts"), "PASS\n", "utf-8");
            return { text: "ok" };
          }
          if (step === FLOW_STEP.PAGE_BROWSER_VERIFY) {
            browserRuns++;
            return {
              text: browserRuns === 1
                ? "{\"overall\":\"fail\",\"scenarios\":[{\"name\":\"score\",\"status\":\"fail\",\"expected\":[\"show\"],\"observed\":[\"blank\"]}]}"
                : "{\"overall\":\"pass\",\"scenarios\":[{\"name\":\"score\",\"status\":\"pass\"}]}",
            };
          }
          if (step === FLOW_STEP.APPLY_FIXES) {
            applyFixRuns++;
            return { text: "ok" };
          }
          return {
            text: "{\"checklist\":[{\"item\":\"ok\",\"verdict\":\"pass\",\"evidence\":\"done\"}],\"issues\":[]}",
          };
        },
      };
    },
  } as any;

  const { factory } = pageRuntimeFactory({
    lintGuard: { async check() {} } as any,
    reviewOrchestrator: { async runPageReview() {} } as any,
  });
  const flow = new PageFlow(boundary, registry, profile, fakeTestAdapter(), [], factory, toolExecutor());
  const plan = {
    type: "page",
    profile: "frontend",
    scope: "quiz/result",
    specPath: "docs/spec/quiz/result.md",
    testCasesPath: "tests/test-cases/quiz/result.md",
    componentSpecPath: "docs/spec/quiz/components.md",
    figmaCachePath: "docs/spec/quiz/figma.json",
    msw: false,
    description: "page",
    targets: [],
    dependencies: [{ name: "dep", importPath: "@/dep" }],
    figmaSlice: "slice",
    browserScenarios: [{ name: "score", objective: "show", route: "/r", preconditions: [], steps: ["open"], expect: ["see"] }],
    targetTestCases: ["shows result"],
    exclusions: [],
    completionCriteria: ["works"],
    designDecisions: [],
  } as any;

  await flow.run("plan.md", { plan });

  assert.equal(browserRuns, 2);
  assert.equal(applyFixRuns, 1);
});
