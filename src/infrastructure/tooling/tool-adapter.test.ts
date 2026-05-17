import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLintAdapter, resolveTestAdapter } from "./tool-adapter.ts";
import { HarnessError } from "../../domain/model/types.ts";

test("built-in lint adapters parse representative outputs", () => {
  const ruff = resolveLintAdapter("ruff");
  const ruffViolations = ruff.parseOutput(
    JSON.stringify([{ filename: "a.py", location: { row: 4 }, message: "bad", code: "F401" }]),
    "",
    1,
  );
  assert.equal(ruffViolations.kind, "violations");

  const mypy = resolveLintAdapter("mypy");
  const mypyViolations = mypy.parseOutput("pkg/file.py:7: error: oops", "", 1);
  assert.equal(mypyViolations.kind, "violations");

  const eslint = resolveLintAdapter("eslint");
  const eslintViolations = eslint.parseOutput(
    JSON.stringify([{ filePath: "/tmp/x.ts", messages: [{ line: 2, message: "bad", ruleId: "no-bad" }] }]),
    "",
    1,
  );
  assert.equal(eslintViolations.kind, "violations");

  const tsc = resolveLintAdapter("tsc");
  const tscViolations = tsc.parseOutput("src/app.ts(3,5): error TS1000: broken", "", 1);
  assert.equal(tscViolations.kind, "violations");

  const biome = resolveLintAdapter("biome");
  assert.equal(biome.parseOutput("", "bad", 1).kind, "tool-error");
});

test("lint adapters also cover ok and tool-error branches plus config resolution", () => {
  const toolRoot = mkdtempSync(join(tmpdir(), "harness-tool-adapter-"));
  writeFileSync(join(toolRoot, "ruff.toml"), "line-length = 88\n", "utf-8");
  writeFileSync(join(toolRoot, "mypy.ini"), "[mypy]\nstrict = true\n", "utf-8");
  writeFileSync(join(toolRoot, "tsconfig.json"), "{\n  \"compilerOptions\": {}\n}\n", "utf-8");

  const ruff = resolveLintAdapter("ruff");
  assert.equal(ruff.parseOutput("", "", 0).kind, "ok");
  assert.equal(ruff.parseOutput("not-json", "stderr", 1).kind, "tool-error");
  assert.deepEqual(ruff.resolveConfigArgs?.(toolRoot), ["--config", join(toolRoot, "ruff.toml")]);
  assert.deepEqual(ruff.formatArgs?.(["a.py"], { configArgs: ["--config", "x"] }), ["format", "--config", "x", "a.py"]);
  assert.deepEqual(ruff.fixArgs?.(["a.py"], { configArgs: [] }), ["check", "--fix", "a.py"]);

  const mypy = resolveLintAdapter("mypy");
  assert.equal(mypy.parseOutput("", "", 0).kind, "ok");
  assert.equal(mypy.parseOutput("nonsense", "stderr", 1).kind, "tool-error");
  assert.equal(mypy.fileFilter?.("pkg/tests/test_mod.py"), false);
  assert.equal(mypy.fileFilter?.("pkg/mod.py"), true);
  assert.deepEqual(mypy.resolveConfigArgs?.(toolRoot), ["--config-file", join(toolRoot, "mypy.ini")]);

  const eslint = resolveLintAdapter("eslint");
  assert.equal(eslint.parseOutput("", "", 0).kind, "ok");
  assert.equal(eslint.parseOutput("not-json", "stderr", 1).kind, "tool-error");
  assert.equal(eslint.parseOutput(JSON.stringify([{ filePath: "/tmp/x.ts", messages: [] }]), "", 1).kind, "ok");
  assert.deepEqual(eslint.checkArgs(["a.ts"], { configArgs: ["--config", "eslint.config.js"] }), ["--format", "json", "--config", "eslint.config.js", "a.ts"]);
  assert.deepEqual(eslint.fixArgs?.(["a.ts"], { configArgs: [] }), ["--fix", "a.ts"]);

  const biome = resolveLintAdapter("biome");
  assert.deepEqual(biome.formatArgs?.(["a.ts"], { configArgs: [] }), ["format", "--write", "a.ts"]);
  assert.deepEqual(biome.checkArgs(["a.ts"], { configArgs: [] }), ["lint", "--reporter=json", "a.ts"]);
  assert.deepEqual(biome.fixArgs?.(["a.ts"], { configArgs: [] }), ["lint", "--fix", "a.ts"]);

  const tsc = resolveLintAdapter("tsc");
  assert.equal(tsc.parseOutput("", "", 0).kind, "ok");
  assert.equal(tsc.parseOutput("nonsense", "", 2).kind, "tool-error");
  assert.deepEqual(tsc.resolveConfigArgs?.(toolRoot), ["--project", join(toolRoot, "tsconfig.json")]);
  assert.deepEqual(tsc.checkArgs([], { configArgs: ["--project", "tsconfig.json"] }), ["--noEmit", "--project", "tsconfig.json"]);
});

test("test adapters classify results", () => {
  const pytest = resolveTestAdapter("pytest");
  assert.equal(pytest.parseResult("", "", 0).kind, "passed");
  assert.equal(pytest.parseResult("", "", 1).kind, "failed");
  assert.equal(pytest.parseResult("ERROR collecting x", "", 2).kind, "collection-error");
  assert.equal(pytest.parseResult("keyboard interrupt", "", 2).kind, "interrupted");
  assert.equal(pytest.parseResult("", "", 5).kind, "no-tests");
  assert.equal(pytest.parseResult("", "", 10).kind, "internal-error");
  assert.deepEqual(pytest.buildArgs("tests/test_mod.py"), ["tests/test_mod.py", "-x", "--tb=short"]);

  const vitest = resolveTestAdapter("vitest");
  assert.equal(vitest.parseResult("", "", 0).kind, "passed");
  assert.equal(vitest.parseResult("No test files found", "", 1).kind, "no-tests");
  assert.equal(vitest.parseResult("Error: config", "", 1).kind, "internal-error");
  assert.equal(vitest.parseResult("FAIL x", "", 1).kind, "failed");
  assert.deepEqual(vitest.buildArgs("src/app.test.ts"), ["run", "src/app.test.ts", "--reporter=verbose"]);
});

test("unknown adapters throw helpful errors", () => {
  assert.throws(() => resolveLintAdapter("unknown"), (error: unknown) =>
    error instanceof HarnessError && error.message.includes("未知の lint ツール"));
  assert.throws(() => resolveTestAdapter("unknown"), (error: unknown) =>
    error instanceof HarnessError && error.message.includes("未知のテストランナー"));
});
