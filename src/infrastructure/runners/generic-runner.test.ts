import test from "node:test";
import assert from "node:assert/strict";
import { createGenericRunner } from "./generic-runner.ts";
import { HarnessError } from "../../domain/model/types.ts";

test("createGenericRunner sends prompts via stdin or prompt flag", async () => {
  const stdinRunner = createGenericRunner({
    name: "stdin-runner",
    command: process.execPath,
    args: ["-e", "process.stdin.on('data', chunk => process.stdout.write(chunk.toString().toUpperCase()))"],
  });
  const stdinResult = await stdinRunner.run({ prompt: "hello" } as any);
  assert.equal(stdinResult.text, "HELLO");

  const flagRunner = createGenericRunner({
    name: "flag-runner",
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.argv[2])", "--"],
    promptFlag: "--prompt",
  });
  const flagResult = await flagRunner.run({ prompt: "hi" } as any);
  assert.equal(flagResult.text, "hi");
});

test("createGenericRunner throws on non-zero exit", async () => {
  const runner = createGenericRunner({
    name: "bad-runner",
    command: process.execPath,
    args: ["-e", "process.stderr.write('bad'); process.exit(2)"],
  });
  await assert.rejects(() => runner.run({ prompt: "x" } as any), HarnessError);
});
