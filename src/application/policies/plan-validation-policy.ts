import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { GuardError } from "../../domain/model/types.ts";
import type { PlanType, TaskPlan } from "../../domain/model/types.ts";
import type { ProjectBoundary } from "../ports/project-boundary.ts";

export function assertPlanType(plan: TaskPlan, expected: PlanType, commandName: string): void {
  if (plan.type !== expected) {
    throw new GuardError(`${commandName} コマンドには type: ${expected} の plan が必要です。現在: ${plan.type ?? "未指定"}`);
  }
}

export function requireString(value: string | undefined, message: string): string {
  if (!value || value.trim() === "") {
    throw new GuardError(message);
  }
  return value;
}

export function requireBoolean(value: boolean | undefined, message: string): boolean {
  if (value === undefined) {
    throw new GuardError(message);
  }
  return value;
}

export function requireArray<T>(value: T[], message: string): T[] {
  if (value.length === 0) {
    throw new GuardError(message);
  }
  return value;
}

export function resolveProjectFile(
  boundary: ProjectBoundary,
  projectRoot: string,
  relativePath: string,
  context: string,
): string {
  const fullPath = resolve(projectRoot, relativePath);
  boundary.assertWithinProject(fullPath);
  if (!existsSync(fullPath)) {
    throw new GuardError(`${context}: ${fullPath}`);
  }
  return fullPath;
}
