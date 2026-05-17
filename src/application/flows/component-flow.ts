import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { FlowRuntimeFactory } from "../ports/flow-runtime-factory.ts";
import type { ProjectBoundary } from "../ports/project-boundary.ts";
import type { ToolExecutor } from "../ports/tool-executor.ts";
import { LintGuard } from "../review/lint-guard.ts";
import { ReviewOrchestrator } from "../review/review-orchestrator.ts";
import type { RunnerRegistry } from "../../infrastructure/runners/runner-registry.ts";
import { FLOW_STEP } from "../../domain/model/steps.ts";
import type { ResolvedProfileConfig, StorybookConfig } from "../../infrastructure/config/config.ts";
import type { LintAdapter } from "../../infrastructure/tooling/tool-adapter.ts";
import type { ReviewIssue, ReviewResult, TaskPlan } from "../../domain/model/types.ts";
import { EVENT } from "../../domain/model/types.ts";
import { loadTemplate, renderTemplate } from "../../infrastructure/templates/templates.ts";
import { parsePlan } from "../../domain/services/plan-parser.ts";
import { applyStepContext } from "../../infrastructure/runners/step-context.ts";
import { buildValidatedComponentPlan, type ValidatedComponentPlan } from "../plan/validated-plan.ts";
import { RETRY_POLICY } from "../policies/retry-policy.ts";
import { filterIssuesToScope, toScopedFiles } from "../policies/review-issue-policy.ts";
import { resolveBundledDoc } from "../resolvers/criteria-resolver.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

type TargetOutcome = {
  target: string;
  resolved: boolean;
  fixAttempts: number;
  changedFiles: string[];
  unresolvedIssues: ReviewIssue[];
};

export class ComponentFlow {
  private boundary: ProjectBoundary;
  private registry: RunnerRegistry;
  private profile: ResolvedProfileConfig;
  private lintAdapters: LintAdapter[];
  private runtimeFactory: FlowRuntimeFactory;
  private toolExecutor: ToolExecutor;

  constructor(
    boundary: ProjectBoundary,
    registry: RunnerRegistry,
    profile: ResolvedProfileConfig,
    _testAdapter: import("../../infrastructure/tooling/tool-adapter.ts").TestAdapter,
    lintAdapters: LintAdapter[],
    runtimeFactory: FlowRuntimeFactory,
    toolExecutor: ToolExecutor,
  ) {
    this.boundary = boundary;
    this.registry = registry;
    this.profile = profile;
    this.lintAdapters = lintAdapters;
    this.runtimeFactory = runtimeFactory;
    this.toolExecutor = toolExecutor;
  }

  async run(planPath: string, options?: { plan?: TaskPlan }): Promise<void> {
    const rawPlan = options?.plan ?? parsePlan(this.boundary.getProjectRoot(), planPath);
    const plan = buildValidatedComponentPlan(this.boundary, rawPlan, this.profile);

    const root = this.boundary.getProjectRoot();
    const { logger, lintGuard, reviewOrchestrator } = this.runtimeFactory.createComponentRuntime({
      taskName: `component_${plan.scope.replace(/\//g, "_")}`,
      projectRoot: root,
      profile: this.profile,
      registry: this.registry,
      lintAdapters: this.lintAdapters,
      toolExecutor: this.toolExecutor,
    });
    const criteriaPath = resolveBundledDoc(root, "review-criteria-component.md", "review-criteria-component.md が見つかりません。");
    const scopeTools = this.boundary.scopeAllowedTools(plan.scope);

    const outcomes: TargetOutcome[] = [];

    for (const target of plan.targets) {
      console.log(`コンポーネントを処理中: ${target}`);
      logger.log(EVENT.REVIEW_START, { mode: "component_target", target });
      const beforeSnapshot = await this.snapshotScopeFiles(plan.scope);

      await this.generateTarget(plan, target, scopeTools);
      await this.boundary.stageFiles(plan.scope);
      await this.boundary.verifyChangedFilesWithinScope(plan.scope);

      const outcome = await this.processTarget(
        plan,
        target,
        beforeSnapshot,
        lintGuard,
        reviewOrchestrator,
        criteriaPath,
        scopeTools,
      );
      outcomes.push(outcome);
    }

    logger.saveReviewData({ plan, targets: outcomes });
    const unresolvedCount = outcomes.filter((outcome) => !outcome.resolved).length;
    console.log(`未収束 target: ${unresolvedCount}`);
  }

  private async generateTarget(
    plan: ValidatedComponentPlan,
    target: string,
    scopeTools: string[],
  ): Promise<void> {
    const root = this.boundary.getProjectRoot();
    const spec = readFileSync(plan.resolvedPaths.specPath, "utf-8");
    const componentSpec = readFileSync(plan.resolvedPaths.componentSpecPath, "utf-8");
    const template = loadTemplate("component-generate", root, this.registry.getConfig().templates);
    const prompt = renderTemplate(template, {
      target,
      spec,
      componentSpec,
      dependencies: stringifyYaml(
        plan.dependencies.map((dependency) => ({
          name: dependency.name,
          import: dependency.importPath,
        })),
      ),
      figmaSlice: plan.figmaSlice,
      designDecisions: plan.designDecisions.join("\n"),
    });

    const runner = this.registry.getRunner(FLOW_STEP.COMPONENT_GENERATE);
    await runner.run(
      applyStepContext(
        {
          prompt,
          allowedTools: scopeTools,
          cwd: root,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        },
        this.profile,
        FLOW_STEP.COMPONENT_GENERATE,
        root,
      ),
      undefined,
    );
  }

  private async processTarget(
    plan: ValidatedComponentPlan,
    target: string,
    beforeSnapshot: Map<string, string>,
    lintGuard: LintGuard,
    reviewOrchestrator: ReviewOrchestrator,
    criteriaPath: string,
    scopeTools: string[],
  ): Promise<TargetOutcome> {
    let fixAttempts = 0;
    let changedFiles = await this.collectChangedFilesSince(plan.scope, beforeSnapshot);
    let lastIssues: ReviewIssue[] = [];

    for (;;) {
      changedFiles = await this.collectChangedFilesSince(plan.scope, beforeSnapshot);
      lastIssues = await this.runTargetChecks(
        target,
        changedFiles,
        lintGuard,
        reviewOrchestrator,
        criteriaPath,
      );

      if (lastIssues.length === 0) {
        return {
          target,
          resolved: true,
          fixAttempts,
          changedFiles,
          unresolvedIssues: [],
        };
      }

      if (fixAttempts >= RETRY_POLICY.componentFix.maxAttempts) {
        return {
          target,
          resolved: false,
          fixAttempts,
          changedFiles,
          unresolvedIssues: lastIssues,
        };
      }

      fixAttempts++;
      console.log(`指摘を修正中... (${target} ${fixAttempts}/${RETRY_POLICY.componentFix.maxAttempts})`);
      await this.applyFixes(target, lastIssues, scopeTools);
      await this.boundary.stageFiles(plan.scope);
      await this.boundary.verifyChangedFilesWithinScope(plan.scope);
    }
  }

  private async runTargetChecks(
    target: string,
    changedFiles: string[],
    lintGuard: LintGuard,
    reviewOrchestrator: ReviewOrchestrator,
    criteriaPath: string,
  ): Promise<ReviewIssue[]> {
    if (changedFiles.length === 0) {
      return [{
        file: "",
        severity: "critical",
        description: `target "${target}" の生成後に変更ファイルが検出されませんでした。`,
      }];
    }

    const issues: ReviewIssue[] = [];

    try {
      await lintGuard.check(changedFiles);
    } catch (error: unknown) {
      issues.push(this.errorToIssue(error, changedFiles[0], `target "${target}" の静的チェックに失敗しました`));
    }

    const storyIssues = await this.runStoryGates(target, changedFiles);
    issues.push(...storyIssues);

    const reviewResult = await reviewOrchestrator.runComponentReview(changedFiles, [criteriaPath]);
    issues.push(...filterIssuesToScope(reviewResult.issues, toScopedFiles(changedFiles)));

    return issues;
  }

  private async runStoryGates(target: string, changedFiles: string[]): Promise<ReviewIssue[]> {
    const storyFiles = this.findStoryFilesForTarget(target, changedFiles);
    if (storyFiles.length === 0) {
      return [{
        file: changedFiles[0] ?? "",
        severity: "major",
        description: `target "${target}" の Story ファイルが見つかりません。${target}.stories.tsx を生成してください。`,
      }];
    }

    const storyFile = storyFiles[0];
    const issues: ReviewIssue[] = [];
      const renderIssues = await this.runStorybookCommand("render", target, storyFile, this.profile.storybook!);
    issues.push(...renderIssues);
    if (renderIssues.length === 0) {
      const smokeIssues = await this.runStorybookCommand("smoke", target, storyFile, this.profile.storybook!);
      issues.push(...smokeIssues);
    }
    return issues;
  }

  private async runStorybookCommand(
    mode: "render" | "smoke",
    target: string,
    storyFile: string,
    storybook: StorybookConfig,
  ): Promise<ReviewIssue[]> {
    const commandTemplate = mode === "render" ? storybook.renderCommand : storybook.smokeCommand;
    const command = commandTemplate.map((part) => this.expandStorybookArg(part, target, storyFile));
    const [tool, ...args] = command;

    try {
      const result = await this.toolExecutor.run(tool, args, {
        toolRoot: this.profile.toolRoot,
        execOverride: [],
      });
      if (result.exitCode !== 0) {
        const output = `${result.stdout}${result.stderr}`.trim();
        return [{
          file: storyFile,
          severity: "major",
          description: `Storybook ${mode} command が失敗しました。command=${command.join(" ")}. output=${output.slice(0, 1200)}`,
        }];
      }
      return [];
    } catch (error: unknown) {
      const execError = error as { message?: string };
      return [{
        file: storyFile,
        severity: "major",
        description: `Storybook ${mode} command が失敗しました。command=${command.join(" ")}. output=${(execError.message || "").slice(0, 1200)}`,
      }];
    }
  }

  private expandStorybookArg(arg: string, target: string, storyFile: string): string {
    return arg
      .replaceAll("{{target}}", target)
      .replaceAll("{{storyFile}}", storyFile)
      .replaceAll("{{toolRoot}}", this.profile.toolRoot);
  }

  private async applyFixes(target: string, issues: ReviewIssue[], scopeTools: string[]): Promise<void> {
    const issueList = issues
      .map((issue, index) => `${index + 1}. [${issue.severity}] ${issue.file}:${issue.line ?? "?"} - ${issue.description}`)
      .join("\n");
    const prompt = `target "${target}" の component と Story を修正してください。

## 指摘一覧
${issueList}

## 制約
- プレゼンテーション責務のみを扱う
- API、server state、atom/global state、ビジネスロジックを追加しない
- Story は props ベースで状態再現する
- Story は CSF3 形式を維持する
- 指摘の解消に必要な範囲だけ修正する`;

    const runner = this.registry.getRunner(FLOW_STEP.APPLY_FIXES);
    await runner.run(
      applyStepContext(
        {
          prompt,
          allowedTools: scopeTools,
          cwd: this.boundary.getProjectRoot(),
          timeoutMs: DEFAULT_TIMEOUT_MS,
        },
        this.profile,
        FLOW_STEP.APPLY_FIXES,
        this.boundary.getProjectRoot(),
      ),
      undefined,
    );
  }

  private async snapshotScopeFiles(scope: string): Promise<Map<string, string>> {
    const files = await this.boundary.findImplementationFiles(scope);
    const snapshot = new Map<string, string>();
    for (const file of files) {
      snapshot.set(file, this.fileHash(file));
    }
    return snapshot;
  }

  private async collectChangedFilesSince(
    scope: string,
    beforeSnapshot: Map<string, string>,
  ): Promise<string[]> {
    const files = await this.boundary.findImplementationFiles(scope);
    const changed: string[] = [];
    for (const file of files) {
      const hash = this.fileHash(file);
      const previous = beforeSnapshot.get(file);
      if (!previous || previous !== hash) {
        changed.push(file);
      }
    }
    return changed;
  }

  private fileHash(file: string): string {
    return createHash("sha1").update(readFileSync(file)).digest("hex");
  }

  private findStoryFilesForTarget(target: string, changedFiles: string[]): string[] {
    return changedFiles.filter((file) => {
      const name = basename(file);
      return name === `${target}.stories.tsx`
        || name === `${target}.stories.ts`
        || name === `${target}.stories.jsx`
        || name === `${target}.stories.js`;
    });
  }

  private errorToIssue(error: unknown, file: string, prefix: string): ReviewIssue {
    const message = error instanceof Error ? error.message : String(error);
    return {
      file,
      severity: "critical",
      description: `${prefix}: ${message}`,
    };
  }
}
