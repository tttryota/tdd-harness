import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Boundary } from "../../domain/services/boundary.ts";
import { ImplFlow } from "./impl-flow.ts";
import { FLOW_STEP } from "../../domain/model/steps.ts";
import { DefaultFlowRuntimeFactory } from "../../infrastructure/runtime/default-flow-runtime-factory.ts";
import { LauncherToolExecutor } from "../../infrastructure/process/launcher-tool-executor.ts";

function initGitRepo(root: string): void {
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Codex"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root });
}

function fakeTestAdapter() {
  return {
    name: "node",
    frameworkName: "fake",
    fileExtensions: ["ts"],
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

test("`ImplFlow` は RED から GREEN を通過してレポートを生成する", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-impl-flow-"));
  mkdirSync(join(root, "backend", "ingestion", "tests"), { recursive: true });
  mkdirSync(join(root, "docs", "spec", "ingestion"), { recursive: true });
  mkdirSync(join(root, "tests", "test-cases", "ingestion"), { recursive: true });
  writeFileSync(join(root, "docs", "spec", "ingestion", "chunk.md"), "---\nstatus: approved\n---\n", "utf-8");
  writeFileSync(join(root, "tests", "test-cases", "ingestion", "chunk.md"), "---\nstatus: approved\n---\n", "utf-8");
  initGitRepo(root);

  const profile = {
    toolRoot: root,
    exec: [],
    reviewCriteria: [],
    criteriaPreset: "backend",
    sourceLayout: {
      sourceDir: "backend/{{category}}",
      testDir: "backend/{{category}}/tests",
      scopePattern: "backend/{{category}}/*",
      additionalAllowedPrefixes: [".harness/reviews/", ".harness/logs/"],
    },
  } as any;
  const boundary = new Boundary(root, profile.sourceLayout, ["ts"], []);
  const runnerConfig = { codex: { type: "codex" } };
  const registry = {
    getConfig() {
      return { runners: runnerConfig, templates: {} };
    },
    getStepMapping() {
      return {
        [FLOW_STEP.TEST_EXTERNAL_REVIEW]: "codex",
        [FLOW_STEP.IMPL_EXTERNAL_REVIEW]: "codex",
      };
    },
    isStepSkipped() {
      return false;
    },
    getRunner(step: string) {
      return {
        async run() {
          if (step === FLOW_STEP.TEST_GENERATE) {
            writeFileSync(join(root, "backend", "ingestion", "tests", "chunk.test.ts"), "FAIL\n", "utf-8");
            return {
              text: JSON.stringify({
                decision: "updated",
                why: ["added"],
                covered_test_cases: ["case"],
                updated_test_cases: ["case"],
                notes: [],
              }),
              sessionId: "session-1",
            };
          }
          if (step === FLOW_STEP.IMPL_GENERATE) {
            writeFileSync(join(root, "backend", "ingestion", "chunk.ts"), "export const chunk = true;\n", "utf-8");
            writeFileSync(join(root, "backend", "ingestion", "tests", "chunk.test.ts"), "PASS\n", "utf-8");
            return {
              text: JSON.stringify({
                decision: "updated",
                why: ["implemented"],
                covered_requirements: ["req"],
                updated_requirements: ["req"],
                notes: [],
              }),
              sessionId: "session-1",
            };
          }
          return {
            text: "{\"checklist\":[{\"item\":\"ok\",\"verdict\":\"pass\",\"evidence\":\"done\"}],\"issues\":[]}",
            sessionId: "session-1",
          };
        },
      };
    },
  } as any;
  const flow = new ImplFlow(boundary, registry, profile, fakeTestAdapter(), [], new DefaultFlowRuntimeFactory(), new LauncherToolExecutor());
  const plan = {
    type: "impl",
    profile: "backend",
    scope: "ingestion/chunk",
    specPath: "docs/spec/ingestion/chunk.md",
    testCasesPath: "tests/test-cases/ingestion/chunk.md",
    componentSpecPath: undefined,
    figmaCachePath: undefined,
    msw: false,
    description: "impl",
    targets: [],
    dependencies: [],
    figmaSlice: undefined,
    browserScenarios: [],
    targetTestCases: ["case"],
    exclusions: [],
    completionCriteria: [],
    designDecisions: ["keep it simple"],
  } as any;

  await flow.run("plan.md", { plan });

  assert.match(readFileSync(join(root, "backend", "ingestion", "chunk.ts"), "utf-8"), /chunk = true/);
  const reportsDir = join(root, ".harness", "reviews");
  const reportFiles = execFileSync("find", [reportsDir, "-type", "f", "-name", "*.md"]).toString("utf-8");
  assert.match(reportFiles, /\.md/);
  const reviewDataPath = execFileSync("find", [join(root, ".harness", "logs"), "-type", "f", "-name", "review-data.json"])
    .toString("utf-8")
    .trim();
  const reviewData = JSON.parse(readFileSync(reviewDataPath, "utf-8"));
  assert.equal(reviewData.status, "completed");
  assert.equal(reviewData.tdd.alreadyGreen, false);
});

test("`ImplFlow` の `diff_scope` は implementation diff が小さい場合に大きな test diff を無視する", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-impl-flow-diff-scope-"));
  mkdirSync(join(root, "backend", "ingestion", "tests"), { recursive: true });
  mkdirSync(join(root, "docs", "spec", "ingestion"), { recursive: true });
  mkdirSync(join(root, "tests", "test-cases", "ingestion"), { recursive: true });
  writeFileSync(join(root, "docs", "spec", "ingestion", "chunk.md"), "---\nstatus: approved\n---\n", "utf-8");
  writeFileSync(join(root, "tests", "test-cases", "ingestion", "chunk.md"), "---\nstatus: approved\n---\n", "utf-8");
  initGitRepo(root);

  const profile = {
    toolRoot: root,
    exec: [],
    reviewCriteria: [],
    criteriaPreset: "backend",
    sourceLayout: {
      sourceDir: "backend/{{category}}",
      testDir: "backend/{{category}}/tests",
      scopePattern: "backend/{{category}}/*",
      additionalAllowedPrefixes: [".harness/reviews/", ".harness/logs/"],
    },
  } as any;
  const boundary = new Boundary(root, profile.sourceLayout, ["ts"], []);
  const registry = {
    getConfig() {
      return { runners: { codex: { type: "codex" } }, templates: {} };
    },
    getStepMapping() {
      return {
        [FLOW_STEP.TEST_EXTERNAL_REVIEW]: "codex",
        [FLOW_STEP.IMPL_EXTERNAL_REVIEW]: "codex",
      };
    },
    isStepSkipped() {
      return false;
    },
    getRunner(step: string) {
      return {
        async run() {
          if (step === FLOW_STEP.TEST_GENERATE) {
            writeFileSync(join(root, "backend", "ingestion", "tests", "chunk.test.ts"), "FAIL\n", "utf-8");
            return {
              text: JSON.stringify({
                decision: "updated",
                why: ["added"],
                covered_test_cases: ["case"],
                updated_test_cases: ["case"],
                notes: [],
              }),
              sessionId: "session-1",
            };
          }
          if (step === FLOW_STEP.IMPL_GENERATE) {
            const largePassingTest = Array.from({ length: 160 }, (_, index) => `PASS ${index}`).join("\n");
            writeFileSync(join(root, "backend", "ingestion", "chunk.ts"), "export const chunk = true;\n", "utf-8");
            writeFileSync(join(root, "backend", "ingestion", "tests", "chunk.test.ts"), `${largePassingTest}\n`, "utf-8");
            return {
              text: JSON.stringify({
                decision: "updated",
                why: ["implemented"],
                covered_requirements: ["req"],
                updated_requirements: ["req"],
                notes: [],
              }),
              sessionId: "session-1",
            };
          }
          return {
            text: "{\"checklist\":[{\"item\":\"ok\",\"verdict\":\"pass\",\"evidence\":\"done\"}],\"issues\":[]}",
            sessionId: "session-1",
          };
        },
      };
    },
  } as any;

  const flow = new ImplFlow(boundary, registry, profile, fakeTestAdapter(), [], new DefaultFlowRuntimeFactory(), new LauncherToolExecutor());
  const plan = {
    type: "impl",
    profile: "backend",
    scope: "ingestion/chunk",
    specPath: "docs/spec/ingestion/chunk.md",
    testCasesPath: "tests/test-cases/ingestion/chunk.md",
    description: "impl",
    targets: [],
    dependencies: [],
    browserScenarios: [],
    targetTestCases: ["case"],
    exclusions: [],
    completionCriteria: [],
    designDecisions: ["keep it simple"],
  } as any;

  await flow.run("plan.md", { plan });

  assert.match(readFileSync(join(root, "backend", "ingestion", "chunk.ts"), "utf-8"), /chunk = true/);
});
