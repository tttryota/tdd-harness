import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Boundary } from "../../domain/services/boundary.ts";
import { GuardError } from "../../domain/model/types.ts";
import {
  buildValidatedComponentPlan,
  buildValidatedImplPlan,
  buildValidatedPagePlan,
} from "./validated-plan.ts";
import { assertReadyLikeStatus, isReadyLikeStatus } from "../policies/plan-readiness-policy.ts";
import {
  assertPlanType,
  requireArray,
  requireBoolean,
  requireString,
  resolveProjectFile,
} from "../policies/plan-validation-policy.ts";
import { hasRetryRemaining, isRetryExhausted, RETRY_POLICY } from "../policies/retry-policy.ts";
import {
  browserIssuesFromResult,
  filterIssuesToScope,
  hasCriticalOrMajorIssues,
  hasParseFailure,
  reconcileReviewIssues,
  toScopedFiles,
} from "../policies/review-issue-policy.ts";
import {
  nextMinorOnlyCycles,
  shouldAcceptMinorVerdict,
  shouldJudgeMinorAcceptance,
} from "../policies/review-acceptance-policy.ts";
import { resolveBundledDoc, resolveCriteriaPaths } from "../resolvers/criteria-resolver.ts";
import { buildMswInstructions, resolveRuleName, resolveRulesContent } from "../resolvers/rules-resolver.ts";

function frontendLayout() {
  return {
    sourceDir: "frontend/src/{{category}}/{{name}}",
    testDir: "frontend/src/{{category}}/{{name}}/__tests__",
    scopePattern: "frontend/src/{{category}}/{{name}}/*",
    additionalAllowedPrefixes: [],
  };
}

function backendLayout() {
  return {
    sourceDir: "backend/{{category}}",
    testDir: "backend/{{category}}/tests",
    scopePattern: "backend/{{category}}/*",
    additionalAllowedPrefixes: [],
  };
}

test("validated plan builders produce non-optional DTOs and shared policies cover core branches", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-validated-plan-"));
  mkdirSync(join(root, ".harness", "resources", "criteria"), { recursive: true });
  mkdirSync(join(root, ".harness", "resources", "rules"), { recursive: true });
  mkdirSync(join(root, "docs", "spec", "quiz"), { recursive: true });
  mkdirSync(join(root, "tests", "test-cases", "quiz"), { recursive: true });
  writeFileSync(join(root, ".harness", "resources", "criteria", "review-criteria-common.md"), "# common\n", "utf-8");
  writeFileSync(join(root, ".harness", "resources", "criteria", "review-criteria-frontend.md"), "# frontend\n", "utf-8");
  writeFileSync(join(root, ".harness", "resources", "criteria", "review-criteria-component.md"), "# component\n", "utf-8");
  writeFileSync(join(root, ".harness", "resources", "rules", "impl.md"), "# impl rules\n", "utf-8");
  writeFileSync(join(root, ".harness", "resources", "rules", "logic.md"), "# logic rules\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "result.md"), "---\nstatus: approved\n---\n# spec\n", "utf-8");
  writeFileSync(join(root, "tests", "test-cases", "quiz", "result.md"), "---\nstatus: approved\n---\n# cases\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "components.md"), "---\nstatus: approved\n---\n# components\n", "utf-8");
  writeFileSync(join(root, "docs", "spec", "quiz", "figma.json"), "{}", "utf-8");

  const frontendBoundary = new Boundary(root, frontendLayout(), ["ts", "tsx"], []);
  const pagePlan = buildValidatedPagePlan(frontendBoundary, {
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
    designDecisions: [],
  });
  assert.equal(pagePlan.resolvedPaths.specPath.endsWith("/docs/spec/quiz/result.md"), true);
  assert.equal(pagePlan.componentSpecPath, "docs/spec/quiz/components.md");
  assert.equal(pagePlan.msw, false);

  const componentPlan = buildValidatedComponentPlan(frontendBoundary, {
    type: "component",
    profile: "frontend",
    scope: "quiz/result",
    specPath: "docs/spec/quiz/result.md",
    testCasesPath: "",
    componentSpecPath: "docs/spec/quiz/components.md",
    figmaCachePath: "docs/spec/quiz/figma.json",
    msw: false,
    description: "component",
    targets: ["ResultCard"],
    dependencies: [{ name: "QuizCard", importPath: "@/components/QuizCard" }],
    figmaSlice: "slice",
    browserScenarios: [],
    targetTestCases: [],
    exclusions: [],
    completionCriteria: ["works"],
    designDecisions: [],
  }, {
    storybook: {
      renderCommand: ["node", "{{storyFile}}"],
      smokeCommand: ["node", "{{storyFile}}"],
    },
  } as any);
  assert.equal(componentPlan.figmaSlice, "slice");

  const backendBoundary = new Boundary(root, backendLayout(), ["ts"], []);
  const implPlan = buildValidatedImplPlan(backendBoundary, {
    type: "impl",
    profile: "backend",
    scope: "quiz/result",
    specPath: "docs/spec/quiz/result.md",
    testCasesPath: "tests/test-cases/quiz/result.md",
    description: "impl",
    targets: [],
    dependencies: [],
    browserScenarios: [],
    targetTestCases: ["covers case"],
    exclusions: [],
    completionCriteria: [],
    designDecisions: [],
  } as any);
  assert.equal(implPlan.msw, false);
  assert.equal(implPlan.resolvedPaths.testCasesPath.endsWith("/tests/test-cases/quiz/result.md"), true);

  assert.equal(isReadyLikeStatus("approved"), true);
  assert.equal(isReadyLikeStatus("draft"), false);
  assert.throws(() => assertReadyLikeStatus("draft", "仕様書"), /仕様書が ready ではありません/);

  assert.equal(requireString("ok", "nope"), "ok");
  assert.equal(requireBoolean(false, "nope"), false);
  assert.deepEqual(requireArray(["a"], "nope"), ["a"]);
  assert.throws(() => requireString("", "missing"), /missing/);
  assert.throws(() => requireBoolean(undefined, "missing"), /missing/);
  assert.throws(() => requireArray([], "missing"), /missing/);
  assert.doesNotThrow(() => assertPlanType({ type: "page" } as any, "page", "page"));
  assert.throws(() => assertPlanType({ type: "impl" } as any, "page", "page"), /type: page/);
  assert.equal(resolveProjectFile(frontendBoundary, root, "docs/spec/quiz/result.md", "missing").endsWith("/docs/spec/quiz/result.md"), true);
  assert.throws(() => resolveProjectFile(frontendBoundary, root, "docs/spec/quiz/missing.md", "missing"), /missing/);

  assert.deepEqual(resolveCriteriaPaths({
    projectRoot: root,
    explicitCriteria: [".harness/resources/criteria/review-criteria-common.md"],
    criteriaPreset: "frontend",
    defaultFallbackNames: ["review-criteria-common", "review-criteria-frontend"],
  }).paths.length, 3);
  assert.equal(resolveBundledDoc(root, "review-criteria-component.md").endsWith("/.harness/resources/criteria/review-criteria-component.md"), true);
  assert.throws(() => resolveBundledDoc(root, "missing.md"), /missing\.md/);
  assert.throws(() => resolveCriteriaPaths({
    projectRoot: root,
    explicitCriteria: ["missing.md"],
    criteriaPreset: undefined,
  }), /Review criteria not found/);

  assert.equal(resolveRuleName("impl", "frontend"), "logic");
  assert.equal(resolveRuleName("page", "frontend"), "page");
  assert.match(resolveRulesContent(root, "impl").content, /impl rules/);
  assert.match(resolveRulesContent(root, "logic").content, /logic rules/);
  assert.equal(resolveRulesContent(root, undefined).content, "");
  assert.equal(resolveRulesContent(root, "missing").content, "");
  assert.match(buildMswInstructions(true, "test"), /MSW セットアップ/);
  assert.match(buildMswInstructions(true, "impl"), /MSW ハンドラ生成/);
  assert.equal(buildMswInstructions(false, "impl"), "");

  assert.equal(isRetryExhausted(2, RETRY_POLICY.pageBrowser), true);
  assert.equal(hasRetryRemaining(1, RETRY_POLICY.pageBrowser), true);
  assert.equal(nextMinorOnlyCycles(0, [{ file: "x", severity: "minor", description: "minor" }]), 1);
  assert.equal(nextMinorOnlyCycles(1, [{ file: "x", severity: "major", description: "major" }]), 0);
  assert.equal(shouldJudgeMinorAcceptance(2), true);
  assert.equal(shouldAcceptMinorVerdict(2, { safe: true }), true);
  assert.equal(shouldAcceptMinorVerdict(1, { safe: true }), false);

  const scopedIssues = filterIssuesToScope([
    { file: join(root, "frontend", "src", "quiz", "result", "ResultCard.tsx"), severity: "major", description: "keep" },
    { file: join(root, "frontend", "src", "other", "Elsewhere.tsx"), severity: "major", description: "drop" },
    { file: "", severity: "minor", description: "global" },
  ], toScopedFiles([join(root, "frontend", "src", "quiz", "result", "ResultCard.tsx")]));
  assert.equal(scopedIssues.length, 2);
  assert.equal(hasParseFailure([{ file: "", severity: "critical", description: "parse" }]), true);
  assert.equal(hasCriticalOrMajorIssues([{ file: "x", severity: "minor", description: "nit" }]), false);
  const reconciled = reconcileReviewIssues(
    {
      reviewer: "a",
      checklist: [],
      issues: [
        { file: "x.ts", severity: "major", description: "fix" },
        { file: "x.ts", severity: "minor", description: "same" },
        { file: "x.ts", severity: "minor", description: "single" },
      ],
      isLgtm: false,
    },
    {
      reviewer: "b",
      checklist: [],
      issues: [{ file: "x.ts", severity: "minor", description: "same" }],
      isLgtm: false,
    },
  );
  assert.equal(reconciled.toFix.length, 3);
  assert.equal(reconciled.accepted.length, 1);
  assert.equal(browserIssuesFromResult({ overall: "blocked", scenarios: [] })[0]?.severity, "critical");
});
