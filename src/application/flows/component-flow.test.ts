import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Boundary } from "../../domain/services/boundary.ts";
import { ComponentFlow } from "./component-flow.ts";
import { FLOW_STEP } from "../../domain/model/steps.ts";
import { GuardError } from "../../domain/model/types.ts";
import type { ComponentFlowRuntime, FlowRuntimeFactory } from "../ports/flow-runtime-factory.ts";
import type { ToolExecutor } from "../ports/tool-executor.ts";
import type { Logger } from "../ports/logger.ts";
import { buildValidatedComponentPlan } from "../plan/validated-plan.ts";
import { filterIssuesToScope, toScopedFiles } from "../policies/review-issue-policy.ts";
import { resolveBundledDoc } from "../resolvers/criteria-resolver.ts";

function initGitRepo(root: string): void {
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Codex"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root });
}

function frontendProfile(root: string) {
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
    storybook: {
      renderCommand: ["node", "-e", "process.exit(0)", "{{storyFile}}"],
      smokeCommand: ["node", "-e", "process.exit(0)", "{{storyFile}}"],
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

function componentRuntimeFactory(runtimeOverrides?: Partial<ComponentFlowRuntime>) {
  const runtime: ComponentFlowRuntime = {
    logger: fakeLogger(),
    lintGuard: { async check() {} } as any,
    reviewOrchestrator: { async runComponentReview() { return { issues: [] }; } } as any,
    ...runtimeOverrides,
  };
  const factory: FlowRuntimeFactory = {
    createPageRuntime() { throw new Error("unexpected page runtime"); },
    createComponentRuntime() { return runtime; },
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

test("ComponentFlow processes a target end-to-end via injected runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-component-flow-"));
  mkdirSync(join(root, ".harness", "resources", "criteria"), { recursive: true });
  mkdirSync(join(root, "frontend", "src", "quiz", "result"), { recursive: true });
  mkdirSync(join(root, "docs", "spec", "quiz"), { recursive: true });
  writeFileSync(join(root, ".harness", "resources", "criteria", "review-criteria-component.md"), "# criteria\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "result.md"), "---\nstatus: approved\n---\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "components.md"), "---\nstatus: approved\n---\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "figma.json"), "{}", "utf-8");
  initGitRepo(root);

  const profile = frontendProfile(root);
  const boundary = new Boundary(root, profile.sourceLayout, ["ts", "tsx"], []);
  const componentReviews: string[][] = [];
  const registry = {
    getConfig() {
      return { templates: {} };
    },
    getRunner(step: string) {
      return {
        async run() {
          if (step === FLOW_STEP.COMPONENT_GENERATE) {
            writeFileSync(join(root, "frontend", "src", "quiz", "result", "ResultCard.tsx"), "export const ResultCard = () => null;\n", "utf-8");
            writeFileSync(join(root, "frontend", "src", "quiz", "result", "ResultCard.stories.tsx"), "export default {};\n", "utf-8");
          }
          return {
            text: "{\"checklist\":[{\"item\":\"ok\",\"verdict\":\"pass\",\"evidence\":\"done\"}],\"issues\":[]}",
          };
        },
      };
    },
  } as any;
  const { factory } = componentRuntimeFactory({
    reviewOrchestrator: {
      async runComponentReview(files: string[]) {
        componentReviews.push(files);
        return { issues: [] };
      },
    } as any,
  });
  const flow = new ComponentFlow(boundary, registry, profile, {} as never, [], factory, toolExecutor());
  const plan = {
    type: "component",
    profile: "frontend",
    scope: "quiz/result",
    specPath: "docs/spec/quiz/result.md",
    testCasesPath: "",
    componentSpecPath: "docs/spec/quiz/components.md",
    figmaCachePath: "docs/spec/quiz/figma.json",
    description: "component",
    targets: ["ResultCard"],
    dependencies: [{ name: "dep", importPath: "@/dep" }],
    figmaSlice: "slice",
    browserScenarios: [],
    targetTestCases: [],
    exclusions: [],
    completionCriteria: ["works"],
    designDecisions: [],
  } as any;

  await flow.run("plan.md", { plan });

  assert.match(readFileSync(join(root, "frontend", "src", "quiz", "result", "ResultCard.tsx"), "utf-8"), /ResultCard/);
  assert.equal(componentReviews.length, 1);
  assert.deepEqual((flow as any).findStoryFilesForTarget("ResultCard", [
    join(root, "frontend", "src", "quiz", "result", "ResultCard.stories.tsx"),
  ]), [join(root, "frontend", "src", "quiz", "result", "ResultCard.stories.tsx")]);
});

test("ComponentFlow validates component plans and scopes review issues to changed files", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-component-validate-"));
  mkdirSync(join(root, ".harness", "resources", "criteria"), { recursive: true });
  mkdirSync(join(root, "frontend", "src", "quiz", "result"), { recursive: true });
  mkdirSync(join(root, "docs", "spec", "quiz"), { recursive: true });
  writeFileSync(join(root, ".harness", "resources", "criteria", "review-criteria-component.md"), "# criteria\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "result.md"), "---\nstatus: approved\n---\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "components.md"), "---\nstatus: approved\n---\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "figma.json"), "{}", "utf-8");
  initGitRepo(root);

  const profile = frontendProfile(root);
  const boundary = new Boundary(root, profile.sourceLayout, ["ts", "tsx"], []);
  const flow = new ComponentFlow(boundary, { getConfig() { return { templates: {} }; } } as any, profile, {} as never, [], componentRuntimeFactory().factory, toolExecutor());

  const validPlan = {
    type: "component",
    profile: "frontend",
    scope: "quiz/result",
    specPath: "docs/spec/quiz/result.md",
    testCasesPath: "",
    componentSpecPath: "docs/spec/quiz/components.md",
    figmaCachePath: "docs/spec/quiz/figma.json",
    description: "component",
    targets: ["ResultCard"],
    dependencies: [{ name: "dep", importPath: "@/dep" }],
    figmaSlice: "slice",
    browserScenarios: [],
    targetTestCases: [],
    exclusions: [],
    completionCriteria: ["works"],
    designDecisions: [],
  } as any;

  assert.equal(
    resolveBundledDoc(root, "review-criteria-component.md", "review-criteria-component.md が見つかりません。"),
    join(root, ".harness", "resources", "criteria", "review-criteria-component.md"),
  );
  assert.throws(() => buildValidatedComponentPlan(boundary, { ...validPlan, dependencies: [] }, profile), GuardError);
  assert.throws(() => buildValidatedComponentPlan(boundary, { ...validPlan, figmaSlice: "" }, profile), /Figma Slice/);

  const scoped = filterIssuesToScope(
    [
      { file: join(root, "frontend", "src", "quiz", "result", "ResultCard.tsx"), severity: "major", description: "keep" },
      { file: join(root, "frontend", "src", "other", "Elsewhere.tsx"), severity: "major", description: "drop" },
      { file: "", severity: "minor", description: "global" },
    ],
    toScopedFiles([join(root, "frontend", "src", "quiz", "result", "ResultCard.tsx")]),
  );
  assert.equal(scoped.length, 2);

  const requiredFieldCases = [
    { patch: { profile: "" }, pattern: /profile が必要/ },
    { patch: { scope: "" }, pattern: /scope が必要/ },
    { patch: { specPath: "" }, pattern: /spec が必要/ },
    { patch: { componentSpecPath: "" }, pattern: /component_spec が必要/ },
    { patch: { figmaCachePath: "" }, pattern: /figma_cache が必要/ },
    { patch: { targets: [] }, pattern: /Targets セクション/ },
    { patch: { dependencies: [] }, pattern: /Dependencies セクション/ },
    { patch: { figmaSlice: "" }, pattern: /Figma Slice セクション/ },
    { patch: { completionCriteria: [] }, pattern: /完了条件 セクション/ },
  ];
  for (const entry of requiredFieldCases) {
    assert.throws(() => buildValidatedComponentPlan(boundary, { ...validPlan, ...entry.patch }, profile), entry.pattern);
  }
});

test("ComponentFlow rejects missing referenced files, draft component specs, and missing storybook config", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-component-branches-"));
  mkdirSync(join(root, ".harness", "resources", "criteria"), { recursive: true });
  mkdirSync(join(root, "frontend", "src", "quiz", "result"), { recursive: true });
  mkdirSync(join(root, "docs", "spec", "quiz"), { recursive: true });
  writeFileSync(join(root, ".harness", "resources", "criteria", "review-criteria-component.md"), "# criteria\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "result.md"), "---\nstatus: approved\n---\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "components.md"), "---\nstatus: approved\n---\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "figma.json"), "{}", "utf-8");
  initGitRepo(root);

  const profile = frontendProfile(root);
  const boundary = new Boundary(root, profile.sourceLayout, ["ts", "tsx"], []);
  const flow = new ComponentFlow(boundary, { getConfig() { return { templates: {} }; } } as any, profile, {} as never, [], componentRuntimeFactory().factory, toolExecutor());
  const validPlan = {
    type: "component",
    profile: "frontend",
    scope: "quiz/result",
    specPath: "docs/spec/quiz/result.md",
    testCasesPath: "",
    componentSpecPath: "docs/spec/quiz/components.md",
    figmaCachePath: "docs/spec/quiz/figma.json",
    description: "component",
    targets: ["ResultCard"],
    dependencies: [{ name: "dep", importPath: "@/dep" }],
    figmaSlice: "slice",
    browserScenarios: [],
    targetTestCases: [],
    exclusions: [],
    completionCriteria: ["works"],
    designDecisions: [],
  } as any;

  assert.throws(
    () => buildValidatedComponentPlan(boundary, { ...validPlan, componentSpecPath: "docs/spec/quiz/missing.md" }, profile),
    /参照ファイルが存在しません/,
  );

  writeFileSync(join(root, "docs", "spec", "quiz", "components.md"), "---\nstatus: draft\n---\n", "utf-8");
  assert.throws(
    () => buildValidatedComponentPlan(boundary, validPlan, profile),
    /コンポーネント定義書が ready ではありません/,
  );

  writeFileSync(join(root, "docs", "spec", "quiz", "components.md"), "---\nstatus: approved\n---\n", "utf-8");
  const profileWithoutStorybook = { ...profile, storybook: undefined } as any;
  const flowWithoutStorybook = new ComponentFlow(
    boundary,
    { getConfig() { return { templates: {} }; } } as any,
    profileWithoutStorybook,
    {} as never,
    [],
    componentRuntimeFactory().factory,
    toolExecutor(),
  );
  assert.throws(
    () => buildValidatedComponentPlan(boundary, validPlan, profileWithoutStorybook),
    /profile\.storybook\.renderCommand \/ smokeCommand の設定が必要/,
  );
});

test("ComponentFlow reports missing stories, expands storybook args, and converts errors to issues", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-component-story-"));
  mkdirSync(join(root, "frontend", "src", "quiz", "result"), { recursive: true });
  const profile = frontendProfile(root);
  const boundary = new Boundary(root, profile.sourceLayout, ["ts", "tsx"], []);
  const flow = new ComponentFlow(boundary, { getConfig() { return { templates: {} }; } } as any, profile, {} as never, [], componentRuntimeFactory().factory, toolExecutor());

  const changedFile = join(root, "frontend", "src", "quiz", "result", "ResultCard.tsx");
  writeFileSync(changedFile, "export const ResultCard = () => null;\n", "utf-8");
  const missingStoryIssues = await (flow as any).runStoryGates("ResultCard", [changedFile]);
  assert.equal(missingStoryIssues[0].severity, "major");
  assert.match(missingStoryIssues[0].description, /Story ファイルが見つかりません/);

  assert.equal(
    (flow as any).expandStorybookArg("{{toolRoot}}/{{target}}/{{storyFile}}", "ResultCard", changedFile),
    `${root}/ResultCard/${changedFile}`,
  );
  assert.match(
    (flow as any).errorToIssue(new Error("boom"), changedFile, "prefix").description,
    /prefix: boom/,
  );
});

test("ComponentFlow generateTarget, applyFixes, and target checks build contract-bearing requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-component-prompts-"));
  mkdirSync(join(root, ".harness", "resources", "criteria"), { recursive: true });
  mkdirSync(join(root, "frontend", "src", "quiz", "result"), { recursive: true });
  mkdirSync(join(root, "docs", "spec", "quiz"), { recursive: true });
  writeFileSync(join(root, ".harness", "resources", "criteria", "review-criteria-component.md"), "# criteria\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "result.md"), "---\nstatus: approved\n---\n# spec\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "components.md"), "---\nstatus: approved\n---\n# components\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "figma.json"), "{}", "utf-8");

  const requests = new Map<string, { prompt: string; allowedTools?: string[] }>();
  const profile = frontendProfile(root);
  const boundary = new Boundary(root, profile.sourceLayout, ["ts", "tsx"], []);
  const registry = {
    getConfig() {
      return { templates: {} };
    },
    getRunner(step: string) {
      return {
        async run(request: { prompt: string; allowedTools?: string[] }) {
          requests.set(step, request);
          return { text: "ok" };
        },
      };
    },
  } as any;
  const flow = new ComponentFlow(boundary, registry, profile, {} as never, [], componentRuntimeFactory().factory, toolExecutor());
  const plan = {
    type: "component",
    profile: "frontend",
    specPath: "docs/spec/quiz/result.md",
    componentSpecPath: "docs/spec/quiz/components.md",
    figmaCachePath: "docs/spec/quiz/figma.json",
    scope: "quiz/result",
    description: "component",
    targets: ["ResultCard"],
    dependencies: [{ name: "QuizCard", importPath: "@/components/QuizCard" }],
    figmaSlice: "slice",
    designDecisions: ["keep props small"],
    browserScenarios: [],
    targetTestCases: [],
    exclusions: [],
    completionCriteria: ["works"],
  } as any;
  const validatedPlan = buildValidatedComponentPlan(boundary, plan, profile);

  await (flow as any).generateTarget(validatedPlan, "ResultCard", ["Read"]);
  await (flow as any).applyFixes("ResultCard", [{ file: "a.tsx", severity: "major", description: "fix me" }], ["Write(frontend/src/quiz/result/*)"]);
  const issues = await (flow as any).runTargetChecks(
    "ResultCard",
    [],
    { async check() {} },
    { async runComponentReview() { return { issues: [] }; } },
    join(root, ".harness", "resources", "criteria", "review-criteria-component.md"),
  );

  assert.match(requests.get(FLOW_STEP.COMPONENT_GENERATE)?.prompt ?? "", /ResultCard/);
  assert.match(requests.get(FLOW_STEP.COMPONENT_GENERATE)?.prompt ?? "", /# spec/);
  assert.match(requests.get(FLOW_STEP.COMPONENT_GENERATE)?.prompt ?? "", /# components/);
  assert.match(requests.get(FLOW_STEP.COMPONENT_GENERATE)?.prompt ?? "", /QuizCard/);
  assert.match(requests.get(FLOW_STEP.COMPONENT_GENERATE)?.prompt ?? "", /keep props small/);
  assert.deepEqual(requests.get(FLOW_STEP.COMPONENT_GENERATE)?.allowedTools, ["Read"]);
  assert.match(requests.get(FLOW_STEP.APPLY_FIXES)?.prompt ?? "", /fix me/);
  assert.match(requests.get(FLOW_STEP.APPLY_FIXES)?.prompt ?? "", /Story/);
  assert.deepEqual(requests.get(FLOW_STEP.APPLY_FIXES)?.allowedTools, ["Write(frontend/src/quiz/result/*)"]);
  assert.match(issues[0].description, /変更ファイルが検出されませんでした/);
});

test("ComponentFlow processTarget retries once and then resolves", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-component-retry-"));
  mkdirSync(join(root, "frontend", "src", "quiz", "result"), { recursive: true });
  const profile = frontendProfile(root);
  const boundary = new Boundary(root, profile.sourceLayout, ["ts", "tsx"], []);
  const flow = new ComponentFlow(boundary, { getConfig() { return { templates: {} }; } } as any, profile, {} as never, [], componentRuntimeFactory().factory, toolExecutor());
  const changedFile = join(root, "frontend", "src", "quiz", "result", "ResultCard.tsx");
  writeFileSync(changedFile, "export const ResultCard = () => null;\n", "utf-8");

  let calls = 0;
  const anyFlow = flow as any;
  anyFlow.collectChangedFilesSince = async () => [changedFile];
  anyFlow.runTargetChecks = async () => {
    calls++;
    return calls === 1 ? [{ file: changedFile, severity: "major", description: "fix" }] : [];
  };
  let fixCalls = 0;
  anyFlow.applyFixes = async () => { fixCalls++; };
  boundary.stageFiles = async () => {};
  boundary.verifyChangedFilesWithinScope = async () => {};

  const outcome = await anyFlow.processTarget(
    { scope: "quiz/result" },
    "ResultCard",
    new Map<string, string>(),
    {} as any,
    {} as any,
    join(root, ".harness", "resources", "criteria", "review-criteria-component.md"),
    ["Write(frontend/src/quiz/result/*)"],
  );

  assert.equal(outcome.resolved, true);
  assert.equal(outcome.fixAttempts, 1);
  assert.equal(fixCalls, 1);
});
