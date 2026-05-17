import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessLogger } from "../../infrastructure/logging/logger.ts";
import { LintGuard } from "./lint-guard.ts";
import type { LintAdapter } from "../../infrastructure/tooling/tool-adapter.ts";
import { DriftError, HarnessError } from "../../domain/model/types.ts";
import type { ToolExecutor } from "../ports/tool-executor.ts";

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-lint-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "file.ts"), "export const x = 1;\n", "utf-8");
  return root;
}

function fakeExecutor(result = { stdout: "", stderr: "", exitCode: 1 }): ToolExecutor {
  return {
    async run() {
      return result;
    },
  };
}

test("LintGuard skips files-mode adapters when no matching files exist", async () => {
  const workspace = makeWorkspace();
  const logger = new HarnessLogger("lint-skip", { baseDir: workspace });
  let called = false;
  const adapter: LintAdapter = {
    name: "node",
    runtime: "node",
    fileExtensions: ["py"],
    excludeDirs: [],
    checkArgs: () => {
      called = true;
      return ["-e", "process.exit(0)"];
    },
    parseOutput: () => ({ kind: "ok" }),
  };

  const guard = new LintGuard(logger, [adapter], { toolRoot: workspace, execOverride: [] }, fakeExecutor());
  await guard.check([join(workspace, "src", "file.ts")]);
  assert.equal(called, false);
});

test("LintGuard retries with claudeFix and rescans files", async () => {
  const workspace = makeWorkspace();
  const logger = new HarnessLogger("lint-retry", { baseDir: workspace });
  let attempts = 0;
  const adapter: LintAdapter = {
    name: "node",
    runtime: "node",
    fileExtensions: ["ts"],
    excludeDirs: [],
    checkArgs: () => ["-e", "process.exit(1)"],
    parseOutput: () => {
      attempts++;
      if (attempts === 1) {
        return { kind: "violations", violations: [{ tool: "node", file: "src/file.ts", line: 1, message: "bad" }] };
      }
      return { kind: "ok" };
    },
  };

  const guard = new LintGuard(logger, [adapter], { toolRoot: workspace, execOverride: [] }, fakeExecutor());
  let fixed = 0;
  await guard.check([join(workspace, "src", "file.ts")], {
    claudeFix: async () => { fixed++; },
    rescanFiles: async () => [join(workspace, "src", "file.ts")],
  });
  assert.equal(fixed, 1);
});

test("LintGuard throws on tool-error and remaining violations", async () => {
  const workspace = makeWorkspace();
  const logger = new HarnessLogger("lint-errors", { baseDir: workspace });
  const toolErrorAdapter: LintAdapter = {
    name: "node",
    runtime: "node",
    fileExtensions: ["ts"],
    excludeDirs: [],
    checkArgs: () => ["-e", "process.exit(1)"],
    parseOutput: () => ({ kind: "tool-error", message: "bad config" }),
  };
  const guard = new LintGuard(logger, [toolErrorAdapter], { toolRoot: workspace, execOverride: [] }, fakeExecutor());
  await assert.rejects(() => guard.check([join(workspace, "src", "file.ts")]), HarnessError);

  let attempts = 0;
  const violationsAdapter: LintAdapter = {
    name: "node",
    runtime: "node",
    fileExtensions: ["ts"],
    excludeDirs: [],
    checkArgs: () => ["-e", "process.exit(1)"],
    parseOutput: () => {
      attempts++;
      return { kind: "violations", violations: [{ tool: "node", file: "src/file.ts", line: 1, message: `bad-${attempts}` }] };
    },
  };
  const guard2 = new LintGuard(logger, [violationsAdapter], { toolRoot: workspace, execOverride: [] }, fakeExecutor());
  await assert.rejects(() => guard2.check([join(workspace, "src", "file.ts")]), DriftError);
});
