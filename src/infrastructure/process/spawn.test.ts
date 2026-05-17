import test from "node:test";
import assert from "node:assert/strict";
import { spawnWithStdin } from "./spawn.ts";

test("spawnWithStdin captures stdout, stderr, and errors", async () => {
  const ok = await spawnWithStdin(
    process.execPath,
    ["-e", "process.stdin.on('data', chunk => process.stdout.write(chunk.toString().toUpperCase())); process.stderr.write('warn');"],
    "hello",
  );
  assert.equal(ok.stdout, "HELLO");
  assert.equal(ok.stderr, "warn");

  const missing = await spawnWithStdin("definitely-missing-command", [], "");
  assert.equal(missing.exitCode, 1);
  assert.notEqual(missing.stderr.length, 0);
});
