import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlan } from "./plan-parser.ts";
import { GuardError } from "../model/types.ts";

function writePlan(root: string, name: string, content: string): string {
  const planDir = join(root, "plans");
  mkdirSync(planDir, { recursive: true });
  const planPath = join(planDir, name);
  writeFileSync(planPath, content, "utf-8");
  return planPath;
}

test("parsePlan parses a page plan with yaml sections", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-plan-"));
  const planPath = writePlan(root, "page.md", `---
type: page
profile: frontend
scope: quiz/result
spec: docs/spec/quiz/result.md
test_cases: tests/test-cases/quiz/result.md
component_spec: docs/spec/quiz/components.md
figma_cache: docs/figma/result.json
msw: true
---

## 今回やること
結果ページを作る

## Targets
- ResultPage

## Dependencies
- name: useQuiz
  import: frontend/src/features/quiz/useQuiz.ts

## Figma Slice
result figma

## Browser Scenarios
- name: score
  objective: show score
  route: /quiz/result
  preconditions: [logged in]
  steps: [open page]
  expect: [score is visible]

## 対象テストケース
- shows score

## やらないこと
- API implementation

## 完了条件
- page renders

## 設計判断
- keep page dumb
`);

  const plan = parsePlan(root, planPath);
  assert.equal(plan.type, "page");
  assert.equal(plan.profile, "frontend");
  assert.equal(plan.scope, "quiz/result");
  assert.equal(plan.msw, true);
  assert.equal(plan.dependencies[0]?.name, "useQuiz");
  assert.equal(plan.browserScenarios[0]?.route, "/quiz/result");
  assert.deepEqual(plan.targetTestCases, ["shows score"]);
});

test("parsePlan rejects unknown type and invalid boolean", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-plan-invalid-"));
  const invalidType = writePlan(root, "invalid-type.md", `---
type: design
---
`);
  assert.throws(() => parsePlan(root, invalidType), (error: unknown) =>
    error instanceof GuardError && error.message.includes("未知の plan type"));

  const invalidBoolean = writePlan(root, "invalid-bool.md", `---
type: impl
scope: ingestion/chunk
spec: docs/spec/foo.md
test_cases: tests/test-cases/foo.md
msw: maybe
---
`);
  assert.throws(() => parsePlan(root, invalidBoolean), (error: unknown) =>
    error instanceof GuardError && error.message.includes("真偽値フィールドに不正な値"));
});

test("parsePlan rejects invalid dependencies and browser scenarios", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-plan-sections-"));
  const invalidDeps = writePlan(root, "invalid-deps.md", `---
type: impl
scope: ingestion/chunk
spec: docs/spec/foo.md
test_cases: tests/test-cases/foo.md
---

## Dependencies
name: invalid
`);
  assert.throws(() => parsePlan(root, invalidDeps), (error: unknown) =>
    error instanceof GuardError && error.message.includes("Dependencies セクションは YAML 配列"));

  const invalidScenarios = writePlan(root, "invalid-scenarios.md", `---
type: page
scope: frontend/result
spec: docs/spec/foo.md
test_cases: tests/test-cases/foo.md
component_spec: docs/spec/bar.md
figma_cache: docs/figma.json
msw: false
---

## Browser Scenarios
- name: ok
  objective: x
  route: /x
  preconditions: invalid
  steps: [a]
  expect: [b]
`);
  assert.throws(() => parsePlan(root, invalidScenarios), (error: unknown) =>
    error instanceof GuardError && error.message.includes("preconditions は文字列配列"));
});

test("parsePlan enforces project-root boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-plan-boundary-"));
  const outside = join(root, "..", "outside.md");
  writeFileSync(outside, "---\n---\n", "utf-8");

  assert.throws(() => parsePlan(root, outside), (error: unknown) =>
    error instanceof GuardError && error.message.includes("プロジェクトルート外"));
});
