import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { parse as parseYaml } from "yaml";
import { GuardError } from "../model/types.ts";
import type { TaskPlan } from "../model/types.ts";
import type { BrowserScenario, PlanDependency, PlanType } from "../model/types.ts";

/**
 * plan ファイルを Boundary に依存せずパースする。
 * profile 解決 → Boundary 生成の順序を可能にするために分離。
 */
export function parsePlan(projectRoot: string, planPath: string): TaskPlan {
  const fullPath = resolve(projectRoot, planPath);

  // プロジェクト境界チェック（Boundary.assertWithinProject 相当）
  assertWithinProjectRoot(fullPath, projectRoot);

  if (!existsSync(fullPath)) {
    throw new GuardError(`計画ファイルが存在しません: ${planPath}`);
  }
  // CRLF 正規化 + 見出し末尾スペース除去
  const content = readFileSync(fullPath, "utf-8")
    .replace(/\r\n/g, "\n")
    .replace(/^(## .+?) +$/gm, "$1");
  const frontmatter = readFrontmatter(fullPath);

  const extract = (heading: string): string | undefined => {
    const re = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`);
    return re.exec(content)?.[1];
  };

  const parseList = (text: string | undefined): string[] =>
    (text ?? "")
      .split("\n")
      .map((line) => line.replace(/^(?:-\s+|\d+\.\s+)/, "").trim())
      .filter(Boolean);

  const dependencies = parseDependencies(extract("Dependencies"));
  const browserScenarios = parseBrowserScenarios(extract("Browser Scenarios"));

  return {
    type: parsePlanType(frontmatter.type),
    profile: frontmatter.profile,
    scope: frontmatter.scope ?? "",
    specPath: frontmatter.spec ?? "",
    testCasesPath: frontmatter.test_cases ?? "",
    componentSpecPath: frontmatter.component_spec,
    figmaCachePath: frontmatter.figma_cache,
    msw: parseBoolean(frontmatter.msw),
    description: extract("今回やること")?.trim() ?? "",
    targets: parseList(extract("Targets")),
    dependencies,
    figmaSlice: extract("Figma Slice")?.trim(),
    browserScenarios,
    targetTestCases: parseList(extract("対象テストケース")),
    exclusions: parseList(extract("やらないこと")),
    completionCriteria: parseList(extract("完了条件")),
    designDecisions: parseList(extract("設計判断")),
  };
}

function assertWithinProjectRoot(fullPath: string, projectRoot: string): void {
  const realRoot = realpathSync(resolve(projectRoot));
  // 存在するパスは realpath、存在しないパスは最も近い既存祖先を使う
  let realPath: string;
  if (existsSync(fullPath)) {
    realPath = realpathSync(fullPath);
  } else {
    // 祖先を遡って最も近い既存ディレクトリを探す
    let current = fullPath;
    while (current !== dirname(current)) {
      current = dirname(current);
      if (existsSync(current)) {
        const realAncestor = realpathSync(current);
        const remainder = fullPath.slice(current.length);
        realPath = realAncestor + remainder;
        break;
      }
    }
    realPath ??= fullPath;
  }
  const rel = relative(realRoot, realPath);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new GuardError(
      `パスがプロジェクトルート外を参照しています: ${fullPath}`,
    );
  }
}

function readFrontmatter(filePath: string): Record<string, string> {
  const content = readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return {};

  const parsed = parseYaml(match[1]);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    result[key] = String(value);
  }
  return result;
}

function parsePlanType(raw: string | undefined): PlanType | undefined {
  if (!raw) return undefined;
  if (raw === "impl" || raw === "component" || raw === "page") return raw;
  throw new GuardError(`未知の plan type です: "${raw}"。利用可能: impl, component, page`);
}

function parseBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new GuardError(`真偽値フィールドに不正な値です: "${raw}"。true または false を指定してください。`);
}

function parseDependencies(section: string | undefined): PlanDependency[] {
  if (!section || section.trim() === "") return [];
  const parsed = parseYaml(section);
  if (!Array.isArray(parsed)) {
    throw new GuardError("Dependencies セクションは YAML 配列で指定してください。");
  }

  return parsed.map((item, index) => {
    if (
      typeof item !== "object" || item === null || Array.isArray(item) ||
      typeof (item as Record<string, unknown>).name !== "string" ||
      typeof (item as Record<string, unknown>).import !== "string"
    ) {
      throw new GuardError(`Dependencies[${index}] は name/import を持つオブジェクトである必要があります。`);
    }
    const dep = item as Record<string, unknown>;
    return {
      name: dep.name as string,
      importPath: dep.import as string,
    };
  });
}

function parseBrowserScenarios(section: string | undefined): BrowserScenario[] {
  if (!section || section.trim() === "") return [];
  const parsed = parseYaml(section);
  if (!Array.isArray(parsed)) {
    throw new GuardError("Browser Scenarios セクションは YAML 配列で指定してください。");
  }

  return parsed.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new GuardError(`Browser Scenarios[${index}] はオブジェクトである必要があります。`);
    }
    const record = item as Record<string, unknown>;
    const scenario = {
      name: stringField(record, "name", `Browser Scenarios[${index}]`),
      objective: stringField(record, "objective", `Browser Scenarios[${index}]`),
      route: stringField(record, "route", `Browser Scenarios[${index}]`),
      preconditions: stringListField(record, "preconditions", `Browser Scenarios[${index}]`),
      steps: stringListField(record, "steps", `Browser Scenarios[${index}]`),
      expect: stringListField(record, "expect", `Browser Scenarios[${index}]`),
    } satisfies BrowserScenario;
    return scenario;
  });
}

function stringField(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new GuardError(`${label}.${key} は空でない文字列である必要があります。`);
  }
  return value;
}

function stringListField(record: Record<string, unknown>, key: string, label: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new GuardError(`${label}.${key} は文字列配列である必要があります。`);
  }
  return value as string[];
}
