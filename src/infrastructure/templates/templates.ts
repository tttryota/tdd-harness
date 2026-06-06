import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { HarnessError } from "../../domain/model/types.ts";

export function loadTemplate(
  name: string,
  projectRoot: string,
  configOverrides?: Record<string, string | null>,
): string {
  // project が明示 override したものを最優先にし、次に project-local 慣例パス、
  // 最後に同梱デフォルトへ落とす。これで bundled 更新より project 意図を優先できる。
  // 1. config 指定パス
  const overridePath = configOverrides?.[name];
  if (overridePath) {
    const fullPath = resolve(projectRoot, overridePath);
    if (existsSync(fullPath)) return readFileSync(fullPath, "utf-8");
  }

  // 2. プロジェクト規約パス: {projectRoot}/.harness/resources/templates/{name}.md
  const conventionPath = join(projectRoot, ".harness", "resources", "templates", `${name}.md`);
  if (existsSync(conventionPath)) return readFileSync(conventionPath, "utf-8");

  // 3. ハーネス同梱デフォルト: パッケージ内 resources/templates/{name}.md
  const builtinPath = join(import.meta.dirname ?? "", "..", "..", "..", "resources", "templates", `${name}.md`);
  if (existsSync(builtinPath)) return readFileSync(builtinPath, "utf-8");

  throw new HarnessError(`Template not found: ${name}`);
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}
