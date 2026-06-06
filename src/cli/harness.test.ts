import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, runCli, usageLines, LOCAL_CLI_NAME, type CliDeps, type CliRuntime } from "./harness.ts";

function makeRuntime(overrides?: Partial<CliRuntime>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const runtime: CliRuntime = {
    cwd: () => mkdtempSync(join(tmpdir(), "harness-cli-")),
    isTTY: false,
    writeStdout: (line) => stdout.push(line),
    writeStderr: (line) => stderr.push(line),
    ...overrides,
  };
  return { runtime, stdout, stderr };
}

function makeDeps(overrides?: Partial<CliDeps>): CliDeps {
  const runCalls: string[] = [];
  const base: CliDeps = {
    loadConfig: () => ({ profiles: { frontend: {} }, runners: { codex: { type: "codex" } } }) as any,
    inferProfile: () => "frontend",
    resolveProfile: () => ({
      flow: "full",
      lint: [],
      test: "vitest",
      toolRoot: ".",
      exec: [],
      steps: {},
      sourceLayout: {
        sourceDir: "frontend/src/{{category}}/{{name}}",
        testDir: "frontend/src/{{category}}/{{name}}/__tests__",
        scopePattern: "frontend/src/{{category}}/{{name}}/*",
        additionalAllowedPrefixes: [],
      },
      designLayout: {
        specDir: "docs/spec/{{category}}",
        testCaseDir: "tests/test-cases/{{category}}",
      },
      reviewCriteria: [],
      storybook: { renderCommand: ["node", "-e", ""], smokeCommand: ["node", "-e", ""] },
    }) as any,
    parsePlan: () => ({ profile: "frontend", scope: "quiz/result" }) as any,
    resolveLintAdapter: () => ({ fileExtensions: ["ts"], excludeDirs: [] }) as any,
    resolveTestAdapter: () => ({ fileExtensions: ["ts"], excludeDirs: [] }) as any,
    createRunnerRegistry: () => ({}) as any,
    interactiveRunnerAssignment: async () => ({ impl_generate: "codex" }) as any,
    createProjectBoundary: () => ({}) as any,
    createToolExecutor: () => ({ run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }) as any,
    createFlowRuntimeFactory: () => ({}) as any,
    createImplFlow: () => ({ run: async () => { runCalls.push("impl"); } }) as any,
    createPageFlow: () => ({ run: async () => { runCalls.push("page"); } }) as any,
    createComponentFlow: () => ({ run: async () => { runCalls.push("component"); } }) as any,
    createDesignFlow: () => ({ run: async () => { runCalls.push("design"); } }) as any,
    createLogger: () => ({}) as any,
    renderBenchmarkSummary: (dirs) => `summary:${dirs.join(",")}`,
    renderBenchmarkDiagnose: (dirs) => `diagnose:${dirs.join(",")}`,
    syncBundledSkills: () => ["harness-pilot"],
    ...overrides,
  };
  (base as any).runCalls = runCalls;
  return base;
}

test("usageLines advertises the local alias", () => {
  assert.match(usageLines()[1]!, new RegExp(`^  ${LOCAL_CLI_NAME.replaceAll(".", "\\.")} impl`));
});

test("runCli prints usage for empty arguments", async () => {
  const { runtime, stdout } = makeRuntime();
  const code = await runCli([], runtime, makeDeps());
  assert.equal(code, 1);
  assert.equal(stdout[0], "Usage:");
});

test("main formats HarnessError and unexpected errors", async () => {
  const { runtime, stderr } = makeRuntime();
  const harnessFailure = await main(["unknown"], runtime, makeDeps());
  assert.equal(harnessFailure, 1);
  assert.match(stderr[0] ?? "", /\[HarnessError\] Unknown command/);

  const { runtime: runtime2, stderr: stderr2 } = makeRuntime();
  const unexpected = await main(["impl", "plan.md"], runtime2, makeDeps({
    loadConfig: () => {
      throw new Error("boom");
    },
  }));
  assert.equal(unexpected, 1);
  assert.match(stderr2[0] ?? "", /Unexpected error: Error: boom/);
});

test("runCli dispatches commands and interactive assignment only when TTY is enabled", async () => {
  const { runtime } = makeRuntime({ isTTY: true });
  const deps = makeDeps();
  await runCli(["impl", "plan.md"], runtime, deps);
  await runCli(["page", "plan.md", "--no-interactive"], runtime, deps);
  await runCli(["component", "plan.md", "--flow", "light"], runtime, deps);
  await runCli(["design", "quiz/result", "requirements"], runtime, deps);

  const calls = (deps as any).runCalls as string[];
  assert.deepEqual(calls, ["impl", "page", "component", "design"]);
});

test("runCli accepts design --profile before or after positional arguments", async () => {
  const designRuns: Array<{ featureName: string; requirements: string }> = [];
  const resolvedProfiles: string[] = [];
  const deps = makeDeps({
    resolveProfile: (_config, profileName) => {
      resolvedProfiles.push(profileName);
      return makeDeps().resolveProfile({} as any, profileName);
    },
    createDesignFlow: () => ({
      run: async (featureName: string, requirements: string) => {
        designRuns.push({ featureName, requirements });
      },
    }) as any,
  });

  await runCli(["design", "quiz/result", "requirements", "--profile", "backend"], makeRuntime().runtime, deps);
  await runCli(["design", "--profile", "backend", "quiz/result", "requirements"], makeRuntime().runtime, deps);

  assert.deepEqual(designRuns, [
    { featureName: "quiz/result", requirements: "requirements" },
    { featureName: "quiz/result", requirements: "requirements" },
  ]);
  assert.deepEqual(resolvedProfiles, ["backend", "backend"]);
});

test("runCli renders benchmark commands and sync-skills", async () => {
  const { runtime, stdout } = makeRuntime();
  const deps = makeDeps();

  assert.equal(await runCli(["benchmark-summary", "a"], runtime, deps), 0);
  assert.equal(stdout.pop(), "summary:a");
  assert.equal(await runCli(["benchmark-diagnose", "a", "b"], runtime, deps), 0);
  assert.equal(stdout.pop(), "diagnose:a,b");
  assert.equal(await runCli(["sync-skills"], runtime, deps), 0);
  assert.match(stdout.pop() ?? "", /harness-pilot/);
});

test("runCli rejects missing arguments and invalid benchmark arity", async () => {
  const deps = makeDeps();
  const { runtime: implRuntime, stderr: implStderr } = makeRuntime();
  assert.equal(await main(["impl"], implRuntime, deps), 1);
  assert.match(implStderr[0] ?? "", /plan file path required/);

  const { runtime: designRuntime, stderr: designStderr } = makeRuntime();
  assert.equal(await main(["design", "quiz/result"], designRuntime, deps), 1);
  assert.match(designStderr[0] ?? "", /feature name and requirements required/);

  const { runtime: designProfileRuntime, stderr: designProfileStderr } = makeRuntime();
  assert.equal(await main(["design", "--profile", "quiz/result", "requirements"], designProfileRuntime, deps), 1);
  assert.match(designProfileStderr[0] ?? "", /--profile requires a profile name/);

  const { runtime: benchRuntime, stderr: benchStderr } = makeRuntime();
  assert.equal(await main(["benchmark-summary"], benchRuntime, deps), 1);
  assert.match(benchStderr[0] ?? "", /one or two log directories/);
});

test("design command requests --profile when multiple profiles exist", async () => {
  const { runtime, stderr } = makeRuntime();
  const deps = makeDeps({
    loadConfig: () => ({
      profiles: {
        backend: {},
        frontend: {},
      },
      runners: { codex: { type: "codex" } },
    }) as any,
  });

  assert.equal(await main(["design", "quiz/result", "requirements"], runtime, deps), 1);
  assert.match(stderr[0] ?? "", /design コマンドでは --profile <name> を追加してください/);
});

test("repo-local wrapper launches the CLI from .harness/bin/harness", () => {
  const wrapperPath = join(import.meta.dirname ?? "", "..", "..", "bin", "harness");
  const result = spawnSync(wrapperPath, [], { encoding: "utf-8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Usage:/);
});
