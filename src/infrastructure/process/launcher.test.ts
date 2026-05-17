import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool } from "./launcher.ts";
import { HarnessError } from "../../domain/model/types.ts";

function makeToolRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-launcher-"));
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  return root;
}

test("runTool returns non-zero exits as CommandResult", async () => {
  const result = await runTool("node", ["-e", "process.exit(3)"], {
    toolRoot: makeToolRoot(),
    execOverride: [],
  });

  assert.equal(result.exitCode, 3);
});

test("runTool applies execOverride prefix", async () => {
  const result = await runTool("target-tool", ["alpha", "beta"], {
    toolRoot: makeToolRoot(),
    execOverride: ["node", "-e", "process.stdout.write(process.argv.slice(1).join(','))"],
  });

  assert.match(result.stdout, /target-tool,alpha,beta/);
});

test("runTool throws for spawn failures", async () => {
  await assert.rejects(
    () => runTool("definitely-missing-command", [], {
      toolRoot: makeToolRoot(),
      execOverride: [],
    }),
    (error: unknown) => error instanceof HarnessError && error.message.includes("起動に失敗しました"),
  );
});

test("runTool throws for signal exits", async () => {
  await assert.rejects(
    () => runTool("node", ["-e", "process.kill(process.pid, 'SIGTERM')"], {
      toolRoot: makeToolRoot(),
      execOverride: [],
    }),
    (error: unknown) => error instanceof HarnessError && error.message.includes("シグナルで終了しました"),
  );
});

test("runTool throws for oversized output", async () => {
  await assert.rejects(
    () => runTool("node", ["-e", "process.stdout.write('x'.repeat(11 * 1024 * 1024))"], {
      toolRoot: makeToolRoot(),
      execOverride: [],
    }),
    (error: unknown) => error instanceof HarnessError && error.message.includes("maxBuffer"),
  );
});
