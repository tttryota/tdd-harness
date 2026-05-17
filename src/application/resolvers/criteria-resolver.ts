import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { GuardError } from "../../domain/model/types.ts";

export type ResolvedCriteriaPaths = {
  paths: string[];
};

type ResolveCriteriaPathsInput = {
  projectRoot: string;
  explicitCriteria: string[];
  criteriaPreset?: string;
  defaultFallbackNames?: string[];
};

function bundledDocCandidates(projectRoot: string, fileName: string): string[] {
  const packageRoot = join(import.meta.dirname ?? "", "..", "..", "..");
  return [
    join(projectRoot, ".harness", "resources", "criteria", fileName),
    join(packageRoot, "resources", "criteria", fileName),
  ];
}

function resolveOptionalBundledDoc(projectRoot: string, fileName: string): string | undefined {
  for (const candidate of bundledDocCandidates(projectRoot, fileName)) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function resolveBundledDoc(
  projectRoot: string,
  fileName: string,
  notFoundMessage?: string,
): string {
  const resolved = resolveOptionalBundledDoc(projectRoot, fileName);
  if (resolved) return resolved;
  throw new GuardError(notFoundMessage ?? `${fileName} が見つかりません。`);
}

export function resolveCriteriaPaths(input: ResolveCriteriaPathsInput): ResolvedCriteriaPaths {
  const paths: string[] = [];

  for (const criteriaPath of input.explicitCriteria) {
    const fullPath = resolve(input.projectRoot, criteriaPath);
    if (!existsSync(fullPath)) throw new GuardError(`Review criteria not found: ${criteriaPath}`);
    paths.push(fullPath);
  }

  if (input.criteriaPreset) {
    const presetNames = [
      "review-criteria-common.md",
      `review-criteria-${input.criteriaPreset}.md`,
    ];
    for (const name of presetNames) {
      paths.push(resolveBundledDoc(input.projectRoot, name, `Review criteria not found: ${name}`));
    }
  }

  if (input.explicitCriteria.length === 0 && !input.criteriaPreset) {
    for (const name of input.defaultFallbackNames ?? []) {
      const resolved = resolveOptionalBundledDoc(input.projectRoot, `${name}.md`);
      if (resolved) {
        paths.push(resolved);
      }
    }
  }

  return { paths };
}
