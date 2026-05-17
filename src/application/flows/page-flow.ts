import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { FlowRuntimeFactory } from "../ports/flow-runtime-factory.ts";
import type { ProjectBoundary } from "../ports/project-boundary.ts";
import type { ToolExecutor } from "../ports/tool-executor.ts";
import { LintGuard } from "../review/lint-guard.ts";
import type { RunnerRegistry } from "../../infrastructure/runners/runner-registry.ts";
import { FLOW_STEP } from "../../domain/model/steps.ts";
import type { TaskPlan, BrowserVerificationResult, ReviewIssue, BrowserScenarioResult } from "../../domain/model/types.ts";
import { DriftError, GuardError, HarnessError, ESCALATION_LEVEL } from "../../domain/model/types.ts";
import type { ResolvedProfileConfig } from "../../infrastructure/config/config.ts";
import type { LintAdapter, TestAdapter } from "../../infrastructure/tooling/tool-adapter.ts";
import { loadTemplate, renderTemplate } from "../../infrastructure/templates/templates.ts";
import type { LauncherOptions } from "../../infrastructure/process/launcher.ts";
import { parsePlan } from "../../domain/services/plan-parser.ts";
import { applyStepContext } from "../../infrastructure/runners/step-context.ts";
import type { LintViolation } from "../../domain/model/types.ts";
import { buildValidatedPagePlan, type ValidatedPagePlan } from "../plan/validated-plan.ts";
import { RETRY_POLICY } from "../policies/retry-policy.ts";
import { browserIssuesFromResult } from "../policies/review-issue-policy.ts";
import { resolveCriteriaPaths } from "../resolvers/criteria-resolver.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class PageFlow {
  private boundary: ProjectBoundary;
  private registry: RunnerRegistry;
  private profile: ResolvedProfileConfig;
  private testAdapter: TestAdapter;
  private lintAdapters: LintAdapter[];
  private runtimeFactory: FlowRuntimeFactory;
  private toolExecutor: ToolExecutor;

  constructor(
    boundary: ProjectBoundary,
    registry: RunnerRegistry,
    profile: ResolvedProfileConfig,
    testAdapter: TestAdapter,
    lintAdapters: LintAdapter[],
    runtimeFactory: FlowRuntimeFactory,
    toolExecutor: ToolExecutor,
  ) {
    this.boundary = boundary;
    this.registry = registry;
    this.profile = profile;
    this.testAdapter = testAdapter;
    this.lintAdapters = lintAdapters;
    this.runtimeFactory = runtimeFactory;
    this.toolExecutor = toolExecutor;
  }

  async run(planPath: string, options?: { plan?: TaskPlan }): Promise<void> {
    const rawPlan = options?.plan ?? parsePlan(this.boundary.getProjectRoot(), planPath);
    const plan = buildValidatedPagePlan(this.boundary, rawPlan);

    const root = this.boundary.getProjectRoot();
    const { lintGuard, reviewOrchestrator } = this.runtimeFactory.createPageRuntime({
      taskName: `page_${plan.scope.replace(/\//g, "_")}`,
      projectRoot: root,
      profile: this.profile,
      registry: this.registry,
      lintAdapters: this.lintAdapters,
      toolExecutor: this.toolExecutor,
    });
    const criteriaPaths = resolveCriteriaPaths({
      projectRoot: root,
      explicitCriteria: this.profile.reviewCriteria,
      criteriaPreset: this.profile.criteriaPreset,
      defaultFallbackNames: ["review-criteria-common", "review-criteria-frontend"],
    }).paths;
    const scopeTools = this.boundary.scopeAllowedTools(plan.scope);
    const implFilesRescan = () => this.boundary.findImplementationFiles(plan.scope);

    console.log("ページ実装を生成中...");
    await this.generatePage(plan, scopeTools);
    await this.boundary.stageFiles(plan.scope);
    await this.runStaticChecks(lintGuard, plan, scopeTools);
    await this.boundary.verifyChangedFilesWithinScope(plan.scope);

    console.log("ページレビュー実行中...");
    await reviewOrchestrator.runPageReview({
      targetFiles: await implFilesRescan(),
      specPath: plan.resolvedPaths.specPath,
      criteriaPaths,
      runTests: async () => {
        const result = await this.runTests(this.boundary.testPathForScope(plan.scope));
        if (!result.passed) {
          throw new HarnessError(`ページテスト失敗: ${result.output}`);
        }
      },
      rescanFiles: implFilesRescan,
      scopeAllowedTools: this.boundary.implAllowedTools(plan.scope),
      getFileDiff: (files: string[]) => this.boundary.getFileDiff(files),
      designDecisions: plan.designDecisions,
      reviewMode: "implementation",
      testCasesPath: plan.resolvedPaths.testCasesPath,
      componentSpecPath: plan.resolvedPaths.componentSpecPath,
      figmaSlice: plan.figmaSlice,
      dependenciesText: stringifyYaml(
        plan.dependencies.map((dependency) => ({
          name: dependency.name,
          import: dependency.importPath,
        })),
      ),
      browserScenariosText: stringifyYaml(plan.browserScenarios),
    });
    await this.boundary.verifyChangedFilesWithinScope(plan.scope);

    for (let attempt = 1; attempt <= RETRY_POLICY.pageBrowser.maxAttempts; attempt++) {
      console.log(`ブラウザ検証中... (試行 ${attempt}/${RETRY_POLICY.pageBrowser.maxAttempts})`);
      const pageFiles = await implFilesRescan();
      const browserResult = await this.runBrowserVerification(plan, pageFiles);
      if (browserResult.overall === "pass") {
        console.log("ブラウザ検証に通過しました。人間確認に進めます。");
        return;
      }

      if (attempt >= RETRY_POLICY.pageBrowser.maxAttempts) {
        throw new DriftError(
          ESCALATION_LEVEL.LEVEL_1,
          "page_browser_verification",
          `Browser Verification が ${RETRY_POLICY.pageBrowser.maxAttempts} 回の試行でも通過しませんでした。`,
        );
      }

      const browserIssues = browserIssuesFromResult(browserResult);
      console.log("ブラウザ検証で指摘が出たため修正し、レビューに戻ります...");
      await this.applyBrowserFixes(browserIssues, scopeTools);
      await this.runStaticChecks(lintGuard, plan, scopeTools);
      await this.boundary.verifyChangedFilesWithinScope(plan.scope);
      await reviewOrchestrator.runPageReview({
        targetFiles: await implFilesRescan(),
        specPath: plan.resolvedPaths.specPath,
        criteriaPaths,
        runTests: async () => {
          const result = await this.runTests(this.boundary.testPathForScope(plan.scope));
          if (!result.passed) {
            throw new HarnessError(`ページテスト失敗: ${result.output}`);
          }
        },
        rescanFiles: implFilesRescan,
        scopeAllowedTools: this.boundary.implAllowedTools(plan.scope),
        getFileDiff: (files: string[]) => this.boundary.getFileDiff(files),
        designDecisions: plan.designDecisions,
        reviewMode: "implementation",
        testCasesPath: plan.resolvedPaths.testCasesPath,
        componentSpecPath: plan.resolvedPaths.componentSpecPath,
        figmaSlice: plan.figmaSlice,
        dependenciesText: stringifyYaml(
          plan.dependencies.map((dependency) => ({
            name: dependency.name,
            import: dependency.importPath,
          })),
        ),
        browserScenariosText: stringifyYaml(plan.browserScenarios),
      });
      await this.boundary.verifyChangedFilesWithinScope(plan.scope);
    }
  }

  private async generatePage(plan: ValidatedPagePlan, scopeTools: string[]): Promise<void> {
    const root = this.boundary.getProjectRoot();
    const spec = readFileSync(plan.resolvedPaths.specPath, "utf-8");
    const componentSpec = readFileSync(plan.resolvedPaths.componentSpecPath, "utf-8");
    const dependencies = stringifyYaml(
      plan.dependencies.map((dependency) => ({
        name: dependency.name,
        import: dependency.importPath,
      })),
    );
    const browserScenarios = stringifyYaml(plan.browserScenarios);

    const config = this.registry.getConfig();
    const template = loadTemplate("page-generate", root, config.templates);
    const prompt = renderTemplate(template, {
      spec,
      componentSpec,
      dependencies,
      figmaSlice: plan.figmaSlice,
      browserScenarios,
      targetTestCases: plan.targetTestCases.join("\n"),
    });

    const runner = this.registry.getRunner(FLOW_STEP.PAGE_GENERATE);
    await runner.run(
      applyStepContext(
        {
          prompt,
          allowedTools: scopeTools,
          cwd: root,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        },
        this.profile,
        FLOW_STEP.PAGE_GENERATE,
        root,
      ),
      undefined,
    );
  }

  private async runStaticChecks(
    lintGuard: LintGuard,
    plan: ValidatedPagePlan,
    scopeTools: string[],
  ): Promise<void> {
    console.log("静的チェック実行中...");
    const sourceFiles = await this.boundary.findSourceFiles(plan.scope);
    if (sourceFiles.length > 0) {
      await lintGuard.check(sourceFiles, {
        claudeFix: async (violations: LintViolation[]) => {
          const issueList = violations
            .map((violation: LintViolation) => `${violation.tool}: ${violation.file}:${violation.line} - ${violation.message}`)
            .join("\n");
          const runner = this.registry.getRunner(FLOW_STEP.LINT_FIX);
          await runner.run(
            applyStepContext(
              {
                prompt: `以下のリンター違反を修正してください。自動修正できなかった違反です。

## 違反一覧
${issueList}

## 制約
- 指摘された違反のみ修正する
- 既存のロジックや振る舞いを変更しない`,
                allowedTools: scopeTools,
                cwd: this.boundary.getProjectRoot(),
              },
              this.profile,
              FLOW_STEP.LINT_FIX,
              this.boundary.getProjectRoot(),
            ),
            undefined,
          );
        },
      });
    }

    const testResult = await this.runTests(this.boundary.testPathForScope(plan.scope));
    if (!testResult.passed) {
      throw new HarnessError(`ページテスト失敗: ${testResult.output}`);
    }
  }

  private async runTests(
    testPath: string,
  ): Promise<{ passed: boolean; output: string }> {
    const absTestPath = resolve(this.boundary.getProjectRoot(), testPath);
    const args = this.testAdapter.buildArgs(absTestPath);
    const launcherOptions: LauncherOptions = {
      toolRoot: this.profile.toolRoot,
      execOverride: this.profile.exec,
    };
    const result = await this.toolExecutor.run(this.testAdapter.name, args, launcherOptions);
    const testResult = this.testAdapter.parseResult(
      result.stdout,
      result.stderr,
      result.exitCode,
    );

    switch (testResult.kind) {
      case "passed":
        return { passed: true, output: testResult.output };
      case "failed":
        return { passed: false, output: testResult.output };
      case "collection-error":
      case "no-tests":
      case "internal-error":
      case "interrupted":
        throw new GuardError(
          `${this.testAdapter.frameworkName} がページフロー中に失敗しました (kind: ${testResult.kind})。\n${testResult.output}`,
        );
    }
  }

  private async runBrowserVerification(
    plan: ValidatedPagePlan,
    targetFiles: string[],
  ): Promise<BrowserVerificationResult> {
    const root = this.boundary.getProjectRoot();
    const spec = readFileSync(plan.resolvedPaths.specPath, "utf-8");
    const config = this.registry.getConfig();
    const template = loadTemplate("review-page-browser", root, config.templates);
    const prompt = renderTemplate(template, {
      spec,
      browserScenarios: stringifyYaml(plan.browserScenarios),
      fileContents: this.readFiles(targetFiles),
    });

    const runner = this.registry.getRunner(FLOW_STEP.PAGE_BROWSER_VERIFY);
    const response = await runner.run(
      applyStepContext(
        {
          prompt,
          cwd: root,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        },
        this.profile,
        FLOW_STEP.PAGE_BROWSER_VERIFY,
        root,
      ),
      undefined,
    );

    return this.parseBrowserVerificationResult(response.text);
  }

  private parseBrowserVerificationResult(output: string): BrowserVerificationResult {
    const cleaned = output.replace(/```(?:json)?\s*\n([\s\S]*?)```/g, "$1");
    const jsonMatch = /\{[\s\S]*"overall"\s*:\s*"[^"]+"[\s\S]*"scenarios"\s*:\s*\[[\s\S]*\][\s\S]*\}/.exec(cleaned);
    const raw = jsonMatch?.[0] ?? cleaned;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HarnessError("Browser Verification の出力が不正な JSON です。");
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new HarnessError("Browser Verification の出力形式が不正です。");
    }
    const record = parsed as Record<string, unknown>;
    if (record.overall !== "pass" && record.overall !== "fail" && record.overall !== "blocked") {
      throw new HarnessError("Browser Verification の overall は pass/fail/blocked のいずれかである必要があります。");
    }
    if (!Array.isArray(record.scenarios)) {
      throw new HarnessError("Browser Verification の scenarios は配列である必要があります。");
    }

    const scenarios = record.scenarios.map((item, index) => this.parseBrowserScenarioResult(item, index));
    return {
      overall: record.overall,
      scenarios,
    } satisfies BrowserVerificationResult;
  }

  private parseBrowserScenarioResult(item: unknown, index: number): BrowserScenarioResult {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new HarnessError(`Browser Verification scenarios[${index}] の形式が不正です。`);
    }
    const record = item as Record<string, unknown>;
    const status = record.status;
    if (status !== "pass" && status !== "fail" && status !== "blocked") {
      throw new HarnessError(`Browser Verification scenarios[${index}].status は pass/fail/blocked のいずれかである必要があります。`);
    }

    return {
      name: this.requiredString(record.name, `scenarios[${index}].name`),
      status,
      completedSteps: this.optionalStringList(record.completed_steps),
      failedStep: this.optionalString(record.failed_step),
      expected: this.optionalStringList(record.expected),
      observed: this.optionalStringList(record.observed),
      notes: this.optionalString(record.notes),
    };
  }

  private async applyBrowserFixes(
    issues: ReviewIssue[],
    scopeTools: string[],
  ): Promise<void> {
    const issueList = issues
      .map((issue, index) => `${index + 1}. [${issue.severity}] ${issue.description}`)
      .join("\n");
    const prompt = `以下の Browser Verification 指摘を修正してください。

## 指摘一覧
${issueList}

## 制約
- 仕様書の UX 要件に合致するよう修正する
- ページの配線、状態遷移、レンダリング不整合の修正を優先する
- 不要なリファクタリングは行わない`;

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

  private readFiles(files: string[]): string {
    return files
      .map((file) => {
        const content = readFileSync(file, "utf-8");
        return `### ${file}\n\`\`\`\n${content}\n\`\`\``;
      })
      .join("\n\n");
  }

  private requiredString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim() === "") {
      throw new HarnessError(`Browser Verification の ${field} は空でない文字列である必要があります。`);
    }
    return value;
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  }

  private optionalStringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string");
  }
}
