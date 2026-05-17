import { spawn } from "node:child_process";

export function spawnWithStdin(
  command: string,
  args: string[],
  stdinData: string,
  cwd?: string,
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    child.on("error", (err) => {
      resolve({ stdout, stderr: err.message, exitCode: 1 });
    });

    child.stdin.write(stdinData);
    child.stdin.end();
  });
}
