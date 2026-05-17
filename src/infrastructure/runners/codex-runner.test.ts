import test from "node:test";
import assert from "node:assert/strict";
import { createCodexRunner, normalizeSandbox } from "./codex-runner.ts";

test("createCodexRunner delegates run and review through injected service", async () => {
  const calls: string[] = [];
  const runner = createCodexRunner({
    sandbox: "workspace-write",
    projectRoot: "/repo",
    model: "gpt-5",
    transportFactory: () => ({
      async close() {
        calls.push("close");
      },
    }) as any,
    serviceFactory: () => ({
      async runTurn(request: Record<string, unknown>, defaults: Record<string, unknown>) {
        calls.push(`run:${String(request.sandboxPolicy)}:${String(defaults.cwd)}`);
        return { text: "ok" };
      },
      async runReview(request: Record<string, unknown>, defaults: Record<string, unknown>) {
        calls.push(`review:${String(request.timeoutMs)}:${String(defaults.cwd)}`);
        return { text: "review" };
      },
    }) as any,
  });

  assert.equal((await runner.run({ prompt: "hello" } as any)).text, "ok");
  assert.equal((await runner.review!({ instructions: "review" } as any)).text, "review");
  assert.deepEqual(calls, ["run:workspace-write:/repo", "close", "review:undefined:/repo", "close"]);
});

test("normalizeSandbox validates values", () => {
  assert.equal(normalizeSandbox(undefined), undefined);
  assert.equal(normalizeSandbox("read-only"), "read-only");
  assert.throws(() => normalizeSandbox("bad"), /Unsupported codex sandbox mode/);
});
