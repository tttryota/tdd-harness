import { existsSync } from "node:fs";
import { join } from "node:path";
import { HarnessError } from "../../domain/model/types.ts";
import type { LintViolation } from "../../domain/model/types.ts";

// === 共通基底 ===

export type AdapterRuntime = "node" | "python" | "system";

export type BaseAdapter = {
  name: string;
  runtime: AdapterRuntime;
  fileExtensions: readonly string[];
  excludeDirs: readonly string[];
};

// === Lint ===

export type LintCheckResult =
  | { kind: "ok" }
  | { kind: "violations"; violations: LintViolation[] }
  | { kind: "tool-error"; message: string };

export type LintAdapterContext = { configArgs: string[] };

export type LintAdapter = BaseAdapter & {
  filePass?: "files" | "project";
  formatArgs?: (files: string[], ctx: LintAdapterContext) => string[];
  fixArgs?: (files: string[], ctx: LintAdapterContext) => string[];
  checkArgs: (files: string[], ctx: LintAdapterContext) => string[];
  parseOutput: (stdout: string, stderr: string, exitCode: number) => LintCheckResult;
  fileFilter?: (file: string) => boolean;
  resolveConfigArgs?: (toolRoot: string) => string[];
};

// === Test ===

export type TestResultKind =
  | "passed"
  | "failed"
  | "interrupted"
  | "collection-error"
  | "no-tests"
  | "internal-error";

export type TestResult = {
  kind: TestResultKind;
  output: string;
  exitCode: number;
};

export type TestAdapter = BaseAdapter & {
  frameworkName: string;
  buildArgs: (testPath: string) => string[];
  parseResult: (stdout: string, stderr: string, exitCode: number) => TestResult;
};

// === パーサ関数 ===

function parseRuffJson(
  stdout: string,
  _stderr: string,
  exitCode: number,
): LintCheckResult {
  if (exitCode === 0) return { kind: "ok" };

  try {
    const parsed = JSON.parse(stdout) as Array<{
      filename: string;
      location: { row: number };
      message: string;
      code: string;
    }>;
    if (parsed.length === 0) return { kind: "ok" };
    return {
      kind: "violations",
      violations: parsed.map((v) => ({
        tool: "ruff_check",
        file: v.filename,
        line: v.location.row,
        message: `${v.code}: ${v.message}`,
      })),
    };
  } catch {
    return {
      kind: "tool-error",
      message: stdout || _stderr,
    };
  }
}

function parseMypyLine(
  stdout: string,
  stderr: string,
  exitCode: number,
): LintCheckResult {
  if (exitCode === 0) return { kind: "ok" };

  const violations: LintViolation[] = [];
  for (const line of stdout.split("\n")) {
    // Windows drive letter (C:\...) / 列番号付き / 列番号なし に対応
    // ファイルパスは greedy（最後の :line: を基準に切り出す）
    const match = /^(.+):(\d+)(?::\d+)?: error: (.+)$/.exec(line);
    if (match) {
      violations.push({
        tool: "mypy",
        file: match[1],
        line: parseInt(match[2], 10),
        message: match[3],
      });
    }
  }

  if (violations.length === 0) {
    return {
      kind: "tool-error",
      message: `mypy が非ゼロで終了しましたが、型エラーを検出できませんでした。\nstdout: ${stdout}\nstderr: ${stderr}`,
    };
  }

  return { kind: "violations", violations };
}

function parseEslintJson(
  stdout: string,
  _stderr: string,
  exitCode: number,
): LintCheckResult {
  if (exitCode === 0) return { kind: "ok" };

  try {
    const parsed = JSON.parse(stdout) as Array<{
      filePath: string;
      messages: Array<{
        line: number;
        message: string;
        ruleId: string | null;
      }>;
    }>;
    const violations: LintViolation[] = [];
    for (const file of parsed) {
      for (const msg of file.messages) {
        violations.push({
          tool: "eslint",
          file: file.filePath,
          line: msg.line,
          message: msg.ruleId ? `${msg.ruleId}: ${msg.message}` : msg.message,
        });
      }
    }
    if (violations.length === 0) return { kind: "ok" };
    return { kind: "violations", violations };
  } catch {
    return { kind: "tool-error", message: stdout || _stderr };
  }
}

function parseBiomeJson(
  stdout: string,
  _stderr: string,
  exitCode: number,
): LintCheckResult {
  if (exitCode === 0) return { kind: "ok" };
  // biome の JSON 出力は将来実装時に詰める。現時点は tool-error
  return { kind: "tool-error", message: `biome exited with ${exitCode}: ${stdout || _stderr}` };
}

function parseTscLine(
  stdout: string,
  _stderr: string,
  exitCode: number,
): LintCheckResult {
  if (exitCode === 0) return { kind: "ok" };

  const violations: LintViolation[] = [];
  for (const line of stdout.split("\n")) {
    // greedy (.+) で正しい: 右端から逆戻りし最後の (line,col) にマッチする
    const match = /^(.+)\((\d+),\d+\): error (TS\d+): (.+)$/.exec(line);
    if (match) {
      violations.push({
        tool: "tsc",
        file: match[1],
        line: parseInt(match[2], 10),
        message: `${match[3]}: ${match[4]}`,
      });
    }
  }

  if (violations.length === 0) {
    return {
      kind: "tool-error",
      message: `tsc が非ゼロで終了しましたが、型エラーを検出できませんでした。\nstdout: ${stdout}`,
    };
  }

  return { kind: "violations", violations };
}

// === Built-in Lint Adapters ===

const RUFF_ADAPTER: LintAdapter = {
  name: "ruff",
  runtime: "python",
  fileExtensions: ["py"],
  excludeDirs: ["__pycache__", ".venv"],
  formatArgs: (files, ctx) => ["format", ...ctx.configArgs, ...files],
  fixArgs: (files, ctx) => ["check", "--fix", ...ctx.configArgs, ...files],
  checkArgs: (files, ctx) => [
    "check",
    "--output-format",
    "json",
    ...ctx.configArgs,
    ...files,
  ],
  parseOutput: parseRuffJson,
  resolveConfigArgs: (toolRoot) => {
    for (const c of ["pyproject.toml", "ruff.toml", ".ruff.toml"]) {
      const p = join(toolRoot, c);
      if (existsSync(p)) return ["--config", p];
    }
    return [];
  },
};

const MYPY_ADAPTER: LintAdapter = {
  name: "mypy",
  runtime: "python",
  fileExtensions: ["py"],
  excludeDirs: ["__pycache__", ".venv"],
  checkArgs: (files, ctx) => [...ctx.configArgs, "--strict", ...files],
  parseOutput: parseMypyLine,
  fileFilter: (f) => !/[\\/]tests[\\/]/.test(f),
  // resolveConfigArgs は「完全な argv 断片」を返す（ruff と同じ契約）
  resolveConfigArgs: (toolRoot) => {
    for (const c of ["pyproject.toml", "mypy.ini", ".mypy.ini", "setup.cfg"]) {
      const p = join(toolRoot, c);
      if (existsSync(p)) return ["--config-file", p];
    }
    return [];
  },
};

const ESLINT_ADAPTER: LintAdapter = {
  name: "eslint",
  runtime: "node",
  fileExtensions: ["ts", "tsx", "js", "jsx"],
  excludeDirs: ["node_modules", "dist"],
  checkArgs: (files, ctx) => ["--format", "json", ...ctx.configArgs, ...files],
  fixArgs: (files, ctx) => ["--fix", ...ctx.configArgs, ...files],
  parseOutput: parseEslintJson,
};

const BIOME_ADAPTER: LintAdapter = {
  name: "biome",
  runtime: "node",
  fileExtensions: ["ts", "tsx", "js", "jsx", "json", "css"],
  excludeDirs: ["node_modules"],
  formatArgs: (files, _ctx) => ["format", "--write", ...files],
  checkArgs: (files, _ctx) => ["lint", "--reporter=json", ...files],
  fixArgs: (files, _ctx) => ["lint", "--fix", ...files],
  parseOutput: parseBiomeJson,
};

const TSC_ADAPTER: LintAdapter = {
  name: "tsc",
  runtime: "node",
  fileExtensions: ["ts", "tsx"],
  excludeDirs: ["node_modules", "dist"],
  filePass: "project",
  checkArgs: (_files, ctx) => ["--noEmit", ...ctx.configArgs],
  parseOutput: parseTscLine,
  resolveConfigArgs: (toolRoot) => {
    const p = join(toolRoot, "tsconfig.json");
    if (existsSync(p)) return ["--project", p];
    return [];
  },
};

// === Built-in Test Adapters ===

const PYTEST_ADAPTER: TestAdapter = {
  name: "pytest",
  runtime: "python",
  fileExtensions: ["py"],
  excludeDirs: ["__pycache__", ".venv"],
  frameworkName: "pytest",
  buildArgs: (testPath) => [testPath, "-x", "--tb=short"],
  parseResult: (stdout, stderr, exitCode) => {
    const output = stdout + stderr;
    if (exitCode === 0) return { kind: "passed", output, exitCode };
    if (exitCode === 1) return { kind: "failed", output, exitCode };
    if (exitCode === 2) {
      if (/ERROR\s+collecting/.test(output))
        return { kind: "collection-error", output, exitCode };
      return { kind: "interrupted", output, exitCode };
    }
    if (exitCode === 5) return { kind: "no-tests", output, exitCode };
    return { kind: "internal-error", output, exitCode };
  },
};

const VITEST_ADAPTER: TestAdapter = {
  name: "vitest",
  runtime: "node",
  fileExtensions: ["ts", "tsx", "js", "jsx"],
  excludeDirs: ["node_modules"],
  frameworkName: "vitest",
  buildArgs: (testPath) => ["run", testPath, "--reporter=verbose"],
  parseResult: (stdout, stderr, exitCode) => {
    const output = stdout + stderr;
    if (exitCode === 0) return { kind: "passed", output, exitCode };
    // vitest はテスト未検出時に特定メッセージを出力
    if (/No test files found/i.test(output)) {
      return { kind: "no-tests", output, exitCode };
    }
    // 設定エラーやモジュール解決失敗等
    if (/Error:\s/.test(output) && !/FAIL\s/.test(output)) {
      return { kind: "internal-error", output, exitCode };
    }
    return { kind: "failed", output, exitCode };
  },
};

// === レジストリ ===

export const LINT_REGISTRY: Record<string, LintAdapter> = {
  ruff: RUFF_ADAPTER,
  mypy: MYPY_ADAPTER,
  eslint: ESLINT_ADAPTER,
  biome: BIOME_ADAPTER,
  tsc: TSC_ADAPTER,
};

export const TEST_REGISTRY: Record<string, TestAdapter> = {
  pytest: PYTEST_ADAPTER,
  vitest: VITEST_ADAPTER,
};

export function resolveLintAdapter(name: string): LintAdapter {
  const adapter = LINT_REGISTRY[name];
  if (!adapter) {
    throw new HarnessError(
      `未知の lint ツール: "${name}"。利用可能: ${Object.keys(LINT_REGISTRY).join(", ")}`,
    );
  }
  return adapter;
}

export function resolveTestAdapter(name: string): TestAdapter {
  const adapter = TEST_REGISTRY[name];
  if (!adapter) {
    throw new HarnessError(
      `未知のテストランナー: "${name}"。利用可能: ${Object.keys(TEST_REGISTRY).join(", ")}`,
    );
  }
  return adapter;
}
