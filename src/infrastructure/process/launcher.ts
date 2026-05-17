import { existsSync } from "node:fs";
import { join, dirname, resolve, delimiter } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HarnessError } from "../../domain/model/types.ts";
import type { CommandResult } from "../../domain/model/types.ts";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024; // 10MB
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5分

export type LauncherOptions = {
  toolRoot: string;
  execOverride: string[];
};

/**
 * toolRoot から親方向にたどり、node_modules/.bin と .venv/bin を PATH に追加する。
 * preferLocal パターン（lint-staged と同じ方式）。
 * Windows では PATH キーが "Path" の場合があるため、大小文字非依存で特定する。
 */
function buildLocalEnv(toolRoot: string): NodeJS.ProcessEnv {
  const localPaths: string[] = [];
  let dir = resolve(toolRoot);

  for (;;) {
    const nmBin = join(dir, "node_modules", ".bin");
    if (existsSync(nmBin)) localPaths.push(nmBin);
    const venvBin = join(dir, ".venv", "bin");
    if (existsSync(venvBin)) localPaths.push(venvBin);
    const venvScripts = join(dir, ".venv", "Scripts");
    if (existsSync(venvScripts)) localPaths.push(venvScripts);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Windows 対応: PATH 系キーを大小文字非依存で特定し、重複キーを除去して1つに統一
  const pathKeys = Object.keys(process.env).filter((k) => k.toUpperCase() === "PATH");
  const pathKey = pathKeys[0] ?? "PATH";
  const currentPath = process.env[pathKey] ?? "";

  const env: NodeJS.ProcessEnv = { ...process.env };
  // 重複する PATH 系キーを全て削除
  for (const k of pathKeys) {
    delete env[k];
  }
  // 正規化した1つのキーで書き戻し（空セグメント防止のため filter）
  env[pathKey] = [...localPaths, currentPath].filter(Boolean).join(delimiter);

  return env;
}

/**
 * ツールを実行する。非 0 exit は例外にせず CommandResult として返す。
 * spawn 失敗 / timeout / signal / maxBuffer のみ例外。
 */
export async function runTool(
  toolName: string,
  args: string[],
  options: LauncherOptions,
): Promise<CommandResult> {
  const env = buildLocalEnv(options.toolRoot);

  if (options.execOverride.length > 0) {
    const [cmd, ...prefix] = options.execOverride;
    return safeExec(cmd, [...prefix, toolName, ...args], {
      env,
      cwd: options.toolRoot,
    });
  }

  return safeExec(toolName, args, { env, cwd: options.toolRoot });
}

/**
 * execFileAsync のラッパー。
 * - 非 0 exit（プロセスが正常起動した上での失敗）→ CommandResult として返す
 * - spawn/setup 系エラー（ENOENT, EACCES, ENOTDIR 等）→ HarnessError
 * - timeout (killed=true) → HarnessError
 * - signal 終了 → HarnessError
 * - maxBuffer 超過 → HarnessError
 */
async function safeExec(
  cmd: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      ...options,
      maxBuffer: DEFAULT_MAX_BUFFER,
      timeout: DEFAULT_TIMEOUT_MS,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error: unknown) {
    const e = error as {
      code?: string | number;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
      message?: string;
    };

    // timeout (killed=true)。signal より先に判定（timeout でも SIGTERM が入る環境がある）
    if (e.killed) {
      throw new HarnessError(
        `${cmd} がタイムアウトで終了しました (signal: ${e.signal ?? "none"})`,
      );
    }

    // シグナル終了（外部 SIGTERM 等。timeout ではない）
    if (e.signal) {
      throw new HarnessError(
        `${cmd} がシグナルで終了しました (signal: ${e.signal})`,
      );
    }

    // maxBuffer 超過
    if (
      e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
      (typeof e.message === "string" && e.message.includes("maxBuffer"))
    ) {
      throw new HarnessError(`${cmd} の出力が maxBuffer を超えました。`);
    }

    // spawn/setup 系エラー: code が文字列の場合はプロセスが起動していない
    // (ENOENT, EACCES, ENOTDIR, EMFILE 等)
    if (typeof e.code === "string") {
      throw new HarnessError(
        `${cmd} の起動に失敗しました (${e.code}): ${e.message ?? "unknown error"}`,
      );
    }

    // 非 0 exit（プロセスは正常起動した）→ CommandResult として返す
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}
