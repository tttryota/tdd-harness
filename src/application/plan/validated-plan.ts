import { GuardError } from "../../domain/model/types.ts";
import type { TaskPlan } from "../../domain/model/types.ts";
import type { ResolvedProfileConfig } from "../../infrastructure/config/config.ts";
import type { ProjectBoundary } from "../ports/project-boundary.ts";
import { assertReadyLikeStatus } from "../policies/plan-readiness-policy.ts";
import {
  assertPlanType,
  requireArray,
  requireBoolean,
  requireString,
  resolveProjectFile,
} from "../policies/plan-validation-policy.ts";

type PageResolvedPaths = {
  specPath: string;
  testCasesPath: string;
  componentSpecPath: string;
  figmaCachePath: string;
};

type ComponentResolvedPaths = {
  specPath: string;
  componentSpecPath: string;
  figmaCachePath: string;
};

type ImplResolvedPaths = {
  specPath: string;
  testCasesPath: string;
};

export type ValidatedPagePlan = Omit<TaskPlan, "type" | "profile" | "componentSpecPath" | "figmaCachePath" | "msw" | "figmaSlice"> & {
  type: "page";
  profile: string;
  componentSpecPath: string;
  figmaCachePath: string;
  msw: boolean;
  figmaSlice: string;
  resolvedPaths: PageResolvedPaths;
};

export type ValidatedComponentPlan = Omit<TaskPlan, "type" | "profile" | "componentSpecPath" | "figmaCachePath" | "figmaSlice"> & {
  type: "component";
  profile: string;
  componentSpecPath: string;
  figmaCachePath: string;
  figmaSlice: string;
  resolvedPaths: ComponentResolvedPaths;
};

export type ValidatedImplPlan = Omit<TaskPlan, "type" | "profile" | "msw"> & {
  type: "impl";
  profile: string;
  msw: boolean;
  resolvedPaths: ImplResolvedPaths;
};

export function buildValidatedPagePlan(
  boundary: ProjectBoundary,
  plan: TaskPlan,
): ValidatedPagePlan {
  assertPlanType(plan, "page", "page");
  const profile = requireString(plan.profile, "page plan には profile が必要です。");
  const scope = requireString(plan.scope, "page plan には scope が必要です。");
  const specPath = requireString(plan.specPath, "page plan には spec が必要です。");
  const testCasesPath = requireString(plan.testCasesPath, "page plan には test_cases が必要です。");
  const componentSpecPath = requireString(plan.componentSpecPath, "page plan には component_spec が必要です。");
  const figmaCachePath = requireString(plan.figmaCachePath, "page plan には figma_cache が必要です。");
  const msw = requireBoolean(plan.msw, "page plan には msw が必要です。");
  const figmaSlice = requireString(plan.figmaSlice, "page plan には Figma Slice セクションが必要です。");
  requireArray(plan.dependencies, "page plan には Dependencies セクションが必要です。");
  requireArray(plan.browserScenarios, "page plan には Browser Scenarios セクションが必要です。");
  requireArray(plan.targetTestCases, "page plan には 対象テストケース セクションが必要です。");
  requireArray(plan.completionCriteria, "page plan には 完了条件 セクションが必要です。");

  boundary.validateScope(scope);
  const root = boundary.getProjectRoot();
  const resolvedPaths = {
    specPath: resolveProjectFile(boundary, root, specPath, "page plan の参照ファイルが存在しません"),
    testCasesPath: resolveProjectFile(boundary, root, testCasesPath, "page plan の参照ファイルが存在しません"),
    componentSpecPath: resolveProjectFile(boundary, root, componentSpecPath, "page plan の参照ファイルが存在しません"),
    figmaCachePath: resolveProjectFile(boundary, root, figmaCachePath, "page plan の参照ファイルが存在しません"),
  } satisfies PageResolvedPaths;

  assertReadyLikeStatus(boundary.readFrontmatter(resolvedPaths.specPath).status, "仕様書");
  assertReadyLikeStatus(boundary.readFrontmatter(resolvedPaths.testCasesPath).status, "テストケース");
  assertReadyLikeStatus(boundary.readFrontmatter(resolvedPaths.componentSpecPath).status, "コンポーネント定義書");

  return {
    ...plan,
    type: "page",
    profile,
    scope,
    specPath,
    testCasesPath,
    componentSpecPath,
    figmaCachePath,
    msw,
    figmaSlice,
    resolvedPaths,
  };
}

export function buildValidatedComponentPlan(
  boundary: ProjectBoundary,
  plan: TaskPlan,
  profile: Pick<ResolvedProfileConfig, "storybook">,
): ValidatedComponentPlan {
  assertPlanType(plan, "component", "component");
  const validatedProfile = requireString(plan.profile, "component plan には profile が必要です。");
  const scope = requireString(plan.scope, "component plan には scope が必要です。");
  const specPath = requireString(plan.specPath, "component plan には spec が必要です。");
  const componentSpecPath = requireString(plan.componentSpecPath, "component plan には component_spec が必要です。");
  const figmaCachePath = requireString(plan.figmaCachePath, "component plan には figma_cache が必要です。");
  const figmaSlice = requireString(plan.figmaSlice, "component plan には Figma Slice セクションが必要です。");
  requireArray(plan.targets, "component plan には Targets セクションが必要です。");
  requireArray(plan.dependencies, "component plan には Dependencies セクションが必要です。");
  requireArray(plan.completionCriteria, "component plan には 完了条件 セクションが必要です。");

  boundary.validateScope(scope);
  const root = boundary.getProjectRoot();
  const resolvedPaths = {
    specPath: resolveProjectFile(boundary, root, specPath, "component plan の参照ファイルが存在しません"),
    componentSpecPath: resolveProjectFile(boundary, root, componentSpecPath, "component plan の参照ファイルが存在しません"),
    figmaCachePath: resolveProjectFile(boundary, root, figmaCachePath, "component plan の参照ファイルが存在しません"),
  } satisfies ComponentResolvedPaths;

  assertReadyLikeStatus(boundary.readFrontmatter(resolvedPaths.specPath).status, "仕様書");
  assertReadyLikeStatus(boundary.readFrontmatter(resolvedPaths.componentSpecPath).status, "コンポーネント定義書");
  if (!profile.storybook) {
    throw new GuardError("component フローには profile.storybook.renderCommand / smokeCommand の設定が必要です。");
  }

  return {
    ...plan,
    type: "component",
    profile: validatedProfile,
    scope,
    specPath,
    componentSpecPath,
    figmaCachePath,
    figmaSlice,
    resolvedPaths,
  };
}

export function buildValidatedImplPlan(
  boundary: ProjectBoundary,
  plan: TaskPlan,
): ValidatedImplPlan {
  assertPlanType(plan, "impl", "impl");
  const profile = requireString(plan.profile, "impl plan には profile が必要です。");
  boundary.implementationGuard(plan);
  const specPath = requireString(plan.specPath, "計画ファイルに spec が指定されていません。");
  const testCasesPath = requireString(plan.testCasesPath, "計画ファイルに test_cases が指定されていません。");
  const resolvedPaths = {
    specPath: resolveProjectFile(boundary, boundary.getProjectRoot(), specPath, "仕様書が存在しません"),
    testCasesPath: resolveProjectFile(boundary, boundary.getProjectRoot(), testCasesPath, "テストケースが存在しません"),
  } satisfies ImplResolvedPaths;

  return {
    ...plan,
    type: "impl",
    profile,
    msw: plan.msw ?? false,
    resolvedPaths,
  };
}
