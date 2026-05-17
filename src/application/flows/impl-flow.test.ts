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
