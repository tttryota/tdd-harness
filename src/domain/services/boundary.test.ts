import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Boundary } from "./boundary.ts";
import { GuardError } from "../model/types.ts";

function initGitRepo(root: string): void {
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Codex"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root });
}

test("Boundary finds misplaced test files outside configured testDir", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-boundary-"));
  mkdirSync(join(root, "backend/benchmark/tests"), { recursive: true });
  writeFileSync(join(root, "backend/benchmark/tests/test_expected.py"), "def test_ok():\n    pass\n");
  writeFileSync(join(root, "backend/benchmark/test_markdown_toc.py"), "def test_wrong_place():\n    pass\n");

  const boundary = new Boundary(
    root,
    {
      sourceDir: "backend/{{category}}",
      testDir: "backend/{{category}}/tests",
      scopePattern: "backend/{{category}}/*",
      additionalAllowedPrefixes: [],
    },
    ["py"],
    ["__pycache__", ".venv"],
  );

  const misplaced = await boundary.findMisplacedTestFiles("benchmark/markdown-toc");
  assert.deepEqual(
    misplaced,
    [join(root, "backend/benchmark/test_markdown_toc.py")],
  );
});

test("Boundary validates scope and path segments", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-boundary-validate-"));
  const boundary = new Boundary(root);

  assert.throws(() => boundary.validateScope("single"), GuardError);
  assert.throws(() => boundary.extractCategory("single"), GuardError);
  assert.throws(() => boundary.extractName("single"), GuardError);
  assert.throws(() => boundary.extractCategory("../bad"), GuardError);
  assert.throws(() => boundary.extractName("bad/na)me"), GuardError);
});

test("Boundary discovers source and test files and builds allowed tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-boundary-files-"));
  mkdirSync(join(root, "frontend", "src", "quiz", "result", "__tests__"), { recursive: true });
  writeFileSync(join(root, "frontend", "src", "quiz", "result", "ResultPage.tsx"), "export const x = 1;\n", "utf-8");
  writeFileSync(join(root, "frontend", "src", "quiz", "result", "__tests__", "ResultPage.test.tsx"), "test\n", "utf-8");
  const boundary = new Boundary(root, {
    sourceDir: "frontend/src/{{category}}/{{name}}",
    testDir: "frontend/src/{{category}}/{{name}}/__tests__",
    scopePattern: "frontend/src/{{category}}/{{name}}/*",
    additionalAllowedPrefixes: [".harness/reviews/"],
  }, ["ts", "tsx"], []);

  const sourceFiles = await boundary.findSourceFiles("quiz/result");
  const implFiles = await boundary.findImplementationFiles("quiz/result");
  const testFiles = await boundary.findTestFiles("quiz/result");

  assert.equal(sourceFiles.length, 2);
  assert.equal(implFiles.length, 1);
  assert.equal(testFiles.length, 1);
  assert.equal(boundary.testPathForScope("quiz/result"), "frontend/src/quiz/result/__tests__");
  assert.deepEqual(boundary.scopeAllowedTools("quiz/result"), [
    "Read",
    "Write(frontend/src/quiz/result/*)",
    "Edit(frontend/src/quiz/result/*)",
    "Write(.harness/reviews/**)",
    "Edit(.harness/reviews/**)",
  ]);
  assert.match(boundary.implAllowedTools("quiz/result")[1] ?? "", /frontend\/src\/quiz\/result\/\*\*\/\*\.\{ts,tsx\}/);
});

test("Boundary discovers source files when sourceDir and testDir are separate trees", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-boundary-split-layout-"));
  mkdirSync(join(root, "frontend", "src", "quiz", "result"), { recursive: true });
  mkdirSync(join(root, "frontend", "tests", "quiz", "result"), { recursive: true });
  writeFileSync(join(root, "frontend", "src", "quiz", "result", "ResultPage.tsx"), "export const x = 1;\n", "utf-8");
  writeFileSync(join(root, "frontend", "tests", "quiz", "result", "ResultPage.test.tsx"), "test\n", "utf-8");
  initGitRepo(root);
  writeFileSync(join(root, "frontend", "tests", "quiz", "result", "ResultPage.test.tsx"), "updated\n", "utf-8");

  const boundary = new Boundary(root, {
    sourceDir: "frontend/src/{{category}}/{{name}}",
    testDir: "frontend/tests/{{category}}/{{name}}",
    scopePattern: "frontend/src/{{category}}/{{name}}/*",
    additionalAllowedPrefixes: [],
  }, ["ts", "tsx"], []);

  assert.equal((await boundary.findSourceFiles("quiz/result")).length, 2);
  assert.equal((await boundary.findImplementationFiles("quiz/result")).length, 1);
  assert.equal((await boundary.findTestFiles("quiz/result")).length, 1);
  await boundary.stageFiles("quiz/result");
  await boundary.verifyChangedFilesWithinScope("quiz/result");
});

test("Boundary stages and verifies changed files within scope", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-boundary-git-"));
  mkdirSync(join(root, "backend", "ingestion", "tests"), { recursive: true });
  writeFileSync(join(root, "backend", "ingestion", "mod.py"), "value = 1\n", "utf-8");
  writeFileSync(join(root, "backend", "ingestion", "tests", "test_mod.py"), "def test_x():\n    assert True\n", "utf-8");
  initGitRepo(root);

  const boundary = new Boundary(root);
  writeFileSync(join(root, "backend", "ingestion", "mod.py"), "value = 2\n", "utf-8");
  await boundary.stageFiles("ingestion/chunk");
  await boundary.verifyChangedFilesWithinScope("ingestion/chunk");
  assert.match(await boundary.getCurrentCommitHash(), /^[0-9a-f]{40}$/);
  assert.equal(await boundary.countDiffLines(), 2);
  assert.match(await boundary.getFileDiff([join(root, "backend", "ingestion", "mod.py")]), /value = 2/);

  writeFileSync(join(root, "README.md"), "oops\n", "utf-8");
  await assert.rejects(
    () => boundary.verifyChangedFilesWithinScope("ingestion/chunk"),
    (error: unknown) => error instanceof GuardError && error.message.includes("スコープ外のファイル"),
  );
});

test("Boundary rejects project-external symlinks", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-boundary-symlink-"));
  mkdirSync(join(root, "frontend", "src", "quiz"), { recursive: true });
  const outside = mkdtempSync(join(tmpdir(), "harness-boundary-outside-"));
  symlinkSync(outside, join(root, "frontend", "src", "quiz", "linked"));
  const boundary = new Boundary(root, {
    sourceDir: "frontend/src/{{category}}/{{name}}",
    testDir: "frontend/src/{{category}}/{{name}}/__tests__",
    scopePattern: "frontend/src/{{category}}/{{name}}/*",
    additionalAllowedPrefixes: [],
  }, ["ts"], []);

  await assert.rejects(
    () => boundary.findSourceFiles("quiz/linked"),
    (error: unknown) => error instanceof GuardError && error.message.includes("symlink"),
  );
});

test("Boundary implementationGuard and additional tool scopes enforce review contracts", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-boundary-guard-"));
  mkdirSync(join(root, "backend", "quiz", "tests"), { recursive: true });
  mkdirSync(join(root, ".harness", "reviews"), { recursive: true });
  writeFileSync(join(root, "backend", "quiz", "impl.py"), "value = 1\n", "utf-8");
  writeFileSync(join(root, "backend", "quiz", "tests", "test_impl.py"), "def test_impl():\n    assert True\n", "utf-8");
  writeFileSync(join(root, "spec.md"), "---\nstatus: ready\nowner: \"codex\"\n---\n# spec\n", "utf-8");
  writeFileSync(join(root, "cases.md"), "---\nstatus: approved\n---\n# cases\n", "utf-8");
  initGitRepo(root);

  const boundary = new Boundary(root, {
    sourceDir: "backend/{{category}}",
    testDir: "backend/{{category}}/tests",
    scopePattern: "backend/{{category}}/*",
    additionalAllowedPrefixes: [".harness/reviews"],
  }, ["py"], ["__pycache__", ".venv"]);

  boundary.implementationGuard({
    scope: "quiz/result",
    specPath: "spec.md",
    testCasesPath: "cases.md",
    targetTestCases: ["covers spec"],
  } as any);
  assert.equal(boundary.readFrontmatter(join(root, "spec.md")).owner, "codex");
  assert.deepEqual(boundary.testAllowedTools("quiz/result"), [
    "Read",
    "Write(backend/quiz/tests/**)",
    "Edit(backend/quiz/tests/**)",
    "Write(.harness/reviews/**)",
    "Edit(.harness/reviews/**)",
  ]);

  writeFileSync(join(root, ".harness", "reviews", "note.md"), "review\n", "utf-8");
  await boundary.stageFiles("quiz/result");
  await boundary.verifyChangedFilesWithinScope("quiz/result");

  assert.throws(
    () => boundary.implementationGuard({ specPath: "spec.md", testCasesPath: "cases.md", scope: "quiz/result", targetTestCases: [] } as any),
    /対象テストケースが指定されていません/,
  );
  assert.throws(() => boundary.assertWithinProject(join(root, "..", "outside.txt")), GuardError);
});

test("Boundary covers missing-plan fields, empty directories, and non-git fallbacks", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-boundary-extra-"));
  mkdirSync(join(root, "backend", "quiz"), { recursive: true });
  const boundary = new Boundary(root);

  assert.deepEqual(await boundary.findSourceFiles("quiz/result"), []);
  assert.deepEqual(await boundary.findImplementationFiles("quiz/result"), []);
  assert.deepEqual(await boundary.findTestFiles("quiz/result"), []);
  assert.deepEqual(await boundary.findMisplacedTestFiles("quiz/result"), []);
  await assert.rejects(() => boundary.stageFiles("quiz/result"), GuardError);
  assert.equal(await boundary.getCurrentCommitHash(), "");
  await assert.rejects(() => boundary.countDiffLines(), GuardError);
  assert.equal(await boundary.getFileDiff([join(root, "backend", "quiz", "missing.py")]), "(git diff 取得失敗)");
  await assert.rejects(() => boundary.getFileDiff([join(root, "..", "outside.py")]), GuardError);

  const missingFieldCases = [
    { plan: { testCasesPath: "cases.md", scope: "quiz/result", targetTestCases: ["x"] }, pattern: /spec が指定されていません/ },
    { plan: { specPath: "spec.md", scope: "quiz/result", targetTestCases: ["x"] }, pattern: /test_cases が指定されていません/ },
    { plan: { specPath: "spec.md", testCasesPath: "cases.md", targetTestCases: ["x"] }, pattern: /scope が指定されていません/ },
  ];
  for (const entry of missingFieldCases) {
    assert.throws(() => boundary.implementationGuard(entry.plan as any), entry.pattern);
  }
});

test("Boundary implementationGuard rejects draft spec and test case statuses", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-boundary-draft-status-"));
  writeFileSync(join(root, "spec.md"), "---\nstatus: draft\n---\n# spec\n", "utf-8");
  writeFileSync(join(root, "cases.md"), "---\nstatus: draft\n---\n# cases\n", "utf-8");
  const boundary = new Boundary(root);

  assert.throws(
    () => boundary.implementationGuard({
      scope: "quiz/result",
      specPath: "spec.md",
      testCasesPath: "cases.md",
      targetTestCases: ["case"],
    } as any),
    /仕様書が ready ではありません/,
  );

  writeFileSync(join(root, "spec.md"), "---\nstatus: approved\n---\n# spec\n", "utf-8");
  assert.throws(
    () => boundary.implementationGuard({
      scope: "quiz/result",
      specPath: "spec.md",
      testCasesPath: "cases.md",
      targetTestCases: ["case"],
    } as any),
    /テストケースが ready ではありません/,
  );
});
