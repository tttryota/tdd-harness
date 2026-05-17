import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioCodexAppServerTransport } from "./transport.ts";
import { HarnessError } from "../../../domain/model/types.ts";

function writeServerScript(root: string): string {
  const scriptPath = join(root, "server.js");
  writeFileSync(scriptPath, `
    process.stdin.setEncoding("utf8");
    let buffer = "";
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.method === "notify") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "server/notice", params: { ok: true } }) + "\\n");
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\\n");
        } else if (message.method === "rpc-error") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: 123, message: "broken", data: { why: "test" } } }) + "\\n");
        } else if (message.method === "client-request") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "server/request", params: { ping: true } }) + "\\n");
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\\n");
        } else if (message.method === "never") {
        } else {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { echo: message.params } }) + "\\n");
        }
      }
    });
  `, "utf-8");
  return scriptPath;
}

test("StdioCodexAppServerTransport handles responses, notifications, RPC errors, and close", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-transport-"));
  const scriptPath = writeServerScript(root);
  const transport = new StdioCodexAppServerTransport({
    cwd: root,
    command: process.execPath,
    commandArgs: [scriptPath],
  });

  const notices: unknown[] = [];
  const unsubscribe = transport.subscribe((message) => notices.push(message.params));
  const response = await transport.request("notify", { hello: "world" }, 1000);
  assert.deepEqual(response, { ok: true });
  assert.deepEqual(notices, [{ ok: true }]);

  const clientRequestResponse = await transport.request("client-request", {}, 1000);
  assert.deepEqual(clientRequestResponse, { ok: true });

  await assert.rejects(
    () => transport.request("rpc-error", {}, 1000),
    (error: unknown) => error instanceof HarnessError && error.message.includes("rpc error 123"),
  );

  const pending = transport.request("never", {}, 1000);
  await transport.close();
  await assert.rejects(pending, HarnessError);
  unsubscribe();
});

test("StdioCodexAppServerTransport times out requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-transport-timeout-"));
  const scriptPath = writeServerScript(root);
  const transport = new StdioCodexAppServerTransport({
    cwd: root,
    command: process.execPath,
    commandArgs: [scriptPath],
  });

  await assert.rejects(
    () => transport.request("never", {}, 10),
    (error: unknown) => error instanceof HarnessError && error.message.includes("timed out"),
  );
  await transport.close();
});
