import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { redact } from "../../infrastructure/logging/logger.ts";
import type { ProjectBoundary } from "../ports/project-boundary.ts";
import type { FlowRuntimeFactory } from "../ports/flow-runtime-factory.ts";
import type { ToolExecutor } from "../ports/tool-executor.ts";
import type { RunnerRegistry } from "../../infrastructure/runners/runner-registry.ts";
import { FLOW_STEP } from "../../domain/model/steps.ts";
import { DriftError, GuardError, HarnessError, ESCALATION_LEVEL, EVENT, STEP_ORDER } from "../../domain/model/types.ts";
import type { TaskPlan, ReviewRecord, LintViolation, CompletedStep, ImplReviewData, ReviewDataErrorMeta, ReviewDataStatus } from "../../domain/model/types.ts";
import type { ResolvedProfileConfig } from "../../infrastructure/config/config.ts";
import type { LintAdapter, TestAdapter } from "../../infrastructure/tooling/tool-adapter.ts";
import { loadTemplate, renderTemplate } from "../../infrastructure/templates/templates.ts";
import type { LauncherOptions } from "../../infrastructure/process/launcher.ts";
import { parsePlan } from "../../domain/services/plan-parser.ts";
import { applyStepContext, joinPromptSections } from "../../infrastructure/runners/step-context.ts";
import type { Logger } from "../ports/logger.ts";
import { LintGuard } from "../review/lint-guard.ts";
import { DriftGuard } from "../review/drift-guard.ts";
import { ReviewOrchestrator } from "../review/review-orchestrator.ts";
import { buildValidatedImplPlan, type ValidatedImplPlan } from "../plan/validated-plan.ts";
import { RETRY_POLICY } from "../policies/retry-policy.ts";
import { resolveCriteriaPaths } from "../resolvers/criteria-resolver.ts";
import { buildMswInstructions, resolveRuleName, resolveRulesContent } from "../resolvers/rules-resolver.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const TEST_GENERATION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "why", "covered_test_cases", "updated_test_cases", "notes"],
  properties: {
    decision: { enum: ["noop", "updated", "contract_revision_required"] },
    why: {
      type: "array",
      items: { type: "string" },
    },
    covered_test_cases: {
      type: "array",
      items: { type: "string" },
    },
    updated_test_cases: {
      type: "array",
      items: { type: "string" },
    },
    notes: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;
const IMPL_GENERATION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "why", "covered_requirements", "updated_requirements", "notes"],
  properties: {
    decision: { enum: ["noop", "updated"] },
    why: {
      type: "array",
      items: { type: "string" },
    },
    covered_requirements: {
      type: "array",
      items: { type: "string" },
    },
    updated_requirements: {
      type: "array",
      items: { type: "string" },
    },
    notes: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;

type TestGenerationResult = {
  decision: "noop" | "updated" | "contract_revision_required";
  why: string[];
  coveredTestCases: string[];
  updatedTestCases: string[];
  notes: string[];
};

type ImplGenerationResult = {
  decision: "noop" | "updated";
  why: string[];
  coveredRequirements: string[];
  updatedRequirements: string[];
  notes: string[];
};

/**
 * test generation は structured output で `decision` を返す。
 * fail-closed にするため、配列 shape が少しでも崩れていたら即座に reject する。
 */
function stringArrayField(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new HarnessError(`テスト生成結果の ${fieldName} が不正です。`);
  }
  return value;
}

export function parseTestGenerationResult(raw: string): TestGenerationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HarnessError("テスト生成結果の JSON パースに失敗しました。");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new HarnessError("テスト生成結果がオブジェクトではありません。");
  }

  const record = parsed as Record<string, unknown>;
  const decision = record.decision;
  if (decision !== "noop" && decision !== "updated" && decision !== "contract_revision_required") {
    throw new HarnessError("テスト生成結果の decision が不正です。");
  }

  return {
    decision,
    why: stringArrayField(record.why, "why"),
    coveredTestCases: stringArrayField(record.covered_test_cases, "covered_test_cases"),
    updatedTestCases: stringArrayField(record.updated_test_cases, "updated_test_cases"),
    notes: stringArrayField(record.notes, "notes"),
  };
}

/**
 * `impl_generate` も structured output を前提にする。
 * GREEN 失敗中に `noop` を許すと進行不能になるため、上位で明示的に guard する。
 */
export function parseImplGenerationResult(raw: string): ImplGenerationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HarnessError("実装生成結果の JSON パースに失敗しました。");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new HarnessError("実装生成結果がオブジェクトではありません。");
  }

  const record = parsed as Record<string, unknown>;
  const decision = record.decision;
  if (decision !== "noop" && decision !== "updated") {
    throw new HarnessError("実装生成結果の decision が不正です。");
  }

  return {
    decision,
    why: stringArrayField(record.why, "why"),
    coveredRequirements: stringArrayField(record.covered_requirements, "covered_requirements"),
    updatedRequirements: stringArrayField(record.updated_requirements, "updated_requirements"),
    notes: stringArrayField(record.notes, "notes"),
  };
}

/**
 * `impl` は plan を入力契約にして、RED -> implementation -> GREEN -> review の順を強制する。
 * resume と review checkpoint もここで管理するため、進行順を変えずに helper へ責務分離している。
 */
export class ImplFlow {
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

  private shouldSkip(completedStep: CompletedStep | null, target: CompletedStep): boolean {
    if (!completedStep) return false;
    return STEP_ORDER.indexOf(completedStep) >= STEP_ORDER.indexOf(target);
  }

  private async finishAlreadyGreenRun(
    reviewOrchestrator: ReviewOrchestrator,
    plan: ValidatedImplPlan,
    criteriaPaths: string[],
    testPath: string,
    logger: Logger,
  ): Promise<void> {
    await this.runImplReview(reviewOrchestrator, plan, criteriaPaths, testPath);
    this.generateReport(plan, logger, reviewOrchestrator.getRecords(), { greenAttempts: 0, alreadyGreen: true });
    logger.clearCheckpoint();
    console.log("完了しました。");
  }

  async run(planPath: string, options?: { resume?: boolean; plan?: import("../../domain/model/types.ts").TaskPlan }): Promise<void> {
    const rawPlan = options?.plan ?? parsePlan(this.boundary.getProjectRoot(), planPath);
    const plan = buildValidatedImplPlan(this.boundary, rawPlan);
    const root = this.boundary.getProjectRoot();
    // codexAvailable は drift escalation の Level 2 可否にだけ使う。
    // 実装主経路の runner 可否ではなく、迷走時に別視点を追加できるかを見る。
    const implFlowSteps: import("../../domain/model/steps.ts").FlowStep[] = [
      FLOW_STEP.TEST_EXTERNAL_REVIEW,
      FLOW_STEP.IMPL_EXTERNAL_REVIEW,
    ];
    const stepMapping = this.registry.getStepMapping();
    const runnerConfig = this.registry.getConfig();
    const hasCodex = implFlowSteps.some((step) => {
      if (this.registry.isStepSkipped(step)) return false;
      const runnerName = stepMapping[step];
      if (!runnerName) return false;
      const runner = runnerConfig.runners[runnerName];
      return runner?.type === "codex";
    });
    const { logger, lintGuard, driftGuard, reviewOrchestrator } = this.runtimeFactory.createImplRuntime({
      taskName: `impl_${plan.scope.replace(/\//g, "_")}`,
      projectRoot: root,
      profile: this.profile,
      registry: this.registry,
      lintAdapters: this.lintAdapters,
      toolExecutor: this.toolExecutor,
      resume: options?.resume,
      codexAvailable: hasCodex,
    });

    // checkpoint は completed step ごとに保存し、同じ step を再実行しないために使う。
    const checkpoint = options?.resume ? logger.loadCheckpoint() : null;
    const resumeFrom = checkpoint?.completedStep ?? null;
    let sessionId = checkpoint?.sessionId ?? "";
    let testGenerationDecision = checkpoint?.testGenerationDecision ?? "updated";
    let greenAttempt = checkpoint?.greenAttempt ?? 0;
    let alreadyGreen = false;
    let runError: unknown = null;

    try {

    if (resumeFrom) {
      console.log(`チェックポイントから再開: ${resumeFrom} 以降を実行`);
      // 前回のレビュー記録を復元
      if (checkpoint?.records && checkpoint.records.length > 0) {
        reviewOrchestrator.restoreRecords(checkpoint.records);
      }
    }

    logger.log(EVENT.GUARD_CHECK, { scope: plan.scope, result: "pass" });

    if (resumeFrom && testGenerationDecision === "contract_revision_required") {
      throw new GuardError(
        "前回の test-generate は contract_revision_required で停止しています。依存契約またはテストコード側の契約定義を見直し、通常実行で再開してください。",
      );
    }

    const LINES_PER_TEST_CASE = 30;
    const expectedLines = plan.targetTestCases.length * LINES_PER_TEST_CASE;
    driftGuard.startTask(plan.scope, expectedLines);
    const testPath = this.boundary.testPathForScope(plan.scope);
    const scopeTools = this.boundary.scopeAllowedTools(plan.scope);
    const testTools = this.boundary.testAllowedTools(plan.scope);

    const spec = readFileSync(plan.resolvedPaths.specPath, "utf-8");
    const criteriaPaths = resolveCriteriaPaths({
      projectRoot: root,
      explicitCriteria: this.profile.reviewCriteria,
      criteriaPreset: this.profile.criteriaPreset,
      defaultFallbackNames: ["review-criteria-common", "review-criteria-backend"],
    }).paths;
    const rules = resolveRulesContent(root, resolveRuleName(plan.type, plan.profile)).content;
    const generationSystemPrompt = joinPromptSections([rules]);

    logger.log(EVENT.TDD_START, { testCases: plan.targetTestCases });

    // test_generate が `contract_revision_required` を返した場合は、その時点で停止する。
    // テストを無理に書き換え続けるより、入力契約を人間が見直す方が安全。
    if (!this.shouldSkip(resumeFrom, "test_generated")) {
      console.log("テストコードを生成中...");
      const runner = this.registry.getRunner(FLOW_STEP.TEST_GENERATE);
      const config = this.registry.getConfig();
      const testGenTemplate = loadTemplate("test-generate", root, config.templates);
      const testGenPrompt = renderTemplate(testGenTemplate, {
        testCases: plan.targetTestCases.join("\n"),
        spec,
        frameworkName: this.testAdapter.frameworkName,
        testPath,
        mswInstructions: buildMswInstructions(plan.msw, "test"),
      });
      const testGenResult = await runner.run(
        applyStepContext(
          {
            prompt: testGenPrompt,
            allowedTools: testTools,
            appendSystemPrompt: generationSystemPrompt,
            cwd: root,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            outputSchema: TEST_GENERATION_OUTPUT_SCHEMA,
          },
          this.profile,
          FLOW_STEP.TEST_GENERATE,
          root,
        ),
        logger,
      );
      const parsedTestGenerationResult = parseTestGenerationResult(testGenResult.text);
      sessionId = testGenResult.sessionId ?? "";
      testGenerationDecision = parsedTestGenerationResult.decision;

      if (testGenerationDecision === "contract_revision_required") {
        logger.saveCheckpoint({
          planPath, completedStep: "test_generated", sessionId,
          testGenerationDecision,
          records: [], greenAttempt: 0, timestamp: new Date().toISOString(),
        });
        const reasonText = parsedTestGenerationResult.why.length > 0
          ? parsedTestGenerationResult.why.join(" / ")
          : "理由なし";
        const notesText = parsedTestGenerationResult.notes.length > 0
          ? `\n未確定の契約:\n- ${parsedTestGenerationResult.notes.join("\n- ")}`
          : "";
        throw new GuardError(
          `テストコード側の契約定義見直しが必要です。理由: ${reasonText}${notesText}`,
        );
      }

      await this.reconcileGeneratedTestsPlacement(plan.scope, testPath, testGenerationDecision);

      if (testGenerationDecision === "updated") {
        await this.boundary.stageFiles(plan.scope);
        await this.lintCheck(lintGuard, plan.scope, "テスト生成後", {
          scopeTools: scopeTools,
          root,
        });
      }
      logger.saveCheckpoint({
        planPath, completedStep: "test_generated", sessionId,
        testGenerationDecision,
        records: [], greenAttempt: 0, timestamp: new Date().toISOString(),
      });
    }

    // テストレビュー
    if (!this.shouldSkip(resumeFrom, "test_reviewed")) {
      await this.runTestReview(reviewOrchestrator, plan, testPath, {
        skipExternalReview: testGenerationDecision === "noop",
      });
      logger.saveCheckpoint({
        planPath, completedStep: "test_reviewed", sessionId,
        testGenerationDecision,
        records: reviewOrchestrator.getRecords(), greenAttempt: 0,
        timestamp: new Date().toISOString(),
      });
    }

    // RED 確認
    let redFailureOutput = "";
    // red_confirmed 済み resume では、初回 implementation prompt 用に RED 出力だけ復元する。
    if (this.shouldSkip(resumeFrom, "red_confirmed") && !this.shouldSkip(resumeFrom, "green_confirmed")) {
      const rerunResult = await this.runTests(testPath, { allowCollectionError: true });
      if (rerunResult.passed) {
        // resume 中に既に GREEN なら、implementation をやり直さず review だけ実行する。
        console.log("警告: テストが既にパスしています。実装生成をスキップしてレビューに進みます。");
        logger.log(EVENT.TEST_RUN, { result: "ALREADY_GREEN", output: rerunResult.output });
        alreadyGreen = true;
        await this.finishAlreadyGreenRun(reviewOrchestrator, plan, criteriaPaths, testPath, logger);
        return;
      }
      redFailureOutput = rerunResult.output;
    }
    if (!this.shouldSkip(resumeFrom, "red_confirmed")) {
      console.log("テスト実行中（RED確認）...");
      const redResult = await this.runTests(testPath, { allowCollectionError: true });
      redFailureOutput = redResult.output;

      if (redResult.passed) {
        console.log("警告: テストが既にパスしています。実装生成をスキップしてレビューに進みます。");
        logger.log(EVENT.TEST_RUN, { result: "ALREADY_GREEN", output: redResult.output });
        alreadyGreen = true;
        await this.finishAlreadyGreenRun(reviewOrchestrator, plan, criteriaPaths, testPath, logger);
        return;
      }

      logger.log(EVENT.TEST_RUN, { result: "RED", output: redResult.output });
      logger.saveCheckpoint({
        planPath, completedStep: "red_confirmed", sessionId,
        testGenerationDecision,
        records: reviewOrchestrator.getRecords(), greenAttempt: 0,
        timestamp: new Date().toISOString(),
      });
    }

    // 実装 → GREEN リトライループ
    let lastFailureOutput = redFailureOutput;
    if (!this.shouldSkip(resumeFrom, "green_confirmed")) {
    for (let attempt = 1; attempt <= RETRY_POLICY.implGreen.maxAttempts; attempt++) {
      console.log(`実装コードを生成中... (試行 ${attempt}/${RETRY_POLICY.implGreen.maxAttempts})`);

      const config = this.registry.getConfig();
      const implTemplate = attempt === 1
        ? loadTemplate("impl-generate", root, config.templates)
        : loadTemplate("impl-retry", root, config.templates);
      const implPrompt = renderTemplate(implTemplate, {
        testOutput: lastFailureOutput,
        spec,
        mswInstructions: buildMswInstructions(plan.msw, "impl"),
      });

      const implRunner = this.registry.getRunner(FLOW_STEP.IMPL_GENERATE);
      const implResult = await implRunner.run(
        applyStepContext(
          {
            prompt: implPrompt,
            allowedTools: scopeTools,
            appendSystemPrompt: generationSystemPrompt,
            sessionId,
            cwd: root,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            outputSchema: IMPL_GENERATION_OUTPUT_SCHEMA,
          },
          this.profile,
          FLOW_STEP.IMPL_GENERATE,
          root,
        ),
        logger,
      );
      const parsedImplGenerationResult = parseImplGenerationResult(implResult.text);
      sessionId = implResult.sessionId ?? sessionId;

      if (parsedImplGenerationResult.decision === "noop") {
        const reasonText = parsedImplGenerationResult.why.length > 0
          ? parsedImplGenerationResult.why.join(" / ")
          : "理由なし";
        throw new GuardError(
          `実装生成が noop を返しましたが、直前の RED 確認ではテストが失敗しています。判定が不整合です。理由: ${reasonText}`,
        );
      }

      // 実装生成後にステージング
      await this.boundary.stageFiles(plan.scope);

      // リントチェック
      await this.lintCheck(lintGuard, plan.scope, `実装後 (試行 ${attempt})`, {
        scopeTools: scopeTools,
        root,
      });

      // スコープ外変更の検証
      await this.boundary.verifyChangedFilesWithinScope(plan.scope);

      // GREEN 確認
      console.log("テスト実行中（GREEN確認）...");
      const greenResult = await this.runTests(testPath);
      logger.log(EVENT.TEST_RUN, {
        result: greenResult.passed ? "GREEN" : "FAILED",
        output: greenResult.output,
        attempt,
      });

      if (greenResult.passed) {
        driftGuard.checkTimeout();

        const changedImplFiles = await this.boundary.findChangedImplementationFiles(plan.scope);
        const changedTestFiles = await this.boundary.findChangedTestFiles(plan.scope);
        const implDiffLines = await this.boundary.countDiffLinesForFiles(changedImplFiles);
        const testDiffLines = await this.boundary.countDiffLinesForFiles(changedTestFiles);
        logger.log(EVENT.GUARD_CHECK, {
          scope: plan.scope,
          result: "pass",
          implDiffLines,
          testDiffLines,
        });
        driftGuard.checkDiffScope(implDiffLines);

        logger.saveCheckpoint({
          planPath, completedStep: "green_confirmed", sessionId,
          testGenerationDecision,
          records: reviewOrchestrator.getRecords(), greenAttempt: attempt,
          timestamp: new Date().toISOString(),
        });

        greenAttempt = attempt;
        await this.resumeImplReviewFromCheckpoint({
          reviewOrchestrator,
          plan,
          criteriaPaths,
          testPath,
          logger,
          planPath,
          sessionId,
          testGenerationDecision,
          greenAttempt,
          resumeFrom: "green_confirmed",
          alreadyGreen: false,
        });
        return;
      }

      // 次の試行のために最新の失敗出力を保持
      lastFailureOutput = greenResult.output;

      // 同じ失敗を惰性的に繰り返さないため、GREEN 失敗は drift として記録する。
      const level = driftGuard.recordTestAttempt(plan.scope, false, greenResult.output);
      if (level !== null) {
        logger.log(EVENT.DRIFT_DETECTED, { metric: "green_failure", escalation: level, attempt });
        if (level >= ESCALATION_LEVEL.LEVEL_3) {
          throw new GuardError("迷走検知: 人間のエスカレーションが必要です。");
        }
      }
    }

        throw new GuardError(
          `${RETRY_POLICY.implGreen.maxAttempts} 回の試行でテストが GREEN になりませんでした。`,
        );
    } // end if !shouldSkip green_confirmed

    // GREEN確認済みからの再開: 実装レビューのみ実行
    if (this.shouldSkip(resumeFrom, "green_confirmed") && !this.shouldSkip(resumeFrom, "impl_reviewed")) {
      await this.resumeImplReviewFromCheckpoint({
        reviewOrchestrator,
        plan,
        criteriaPaths,
        testPath,
        logger,
        planPath,
        sessionId,
        testGenerationDecision,
        greenAttempt: checkpoint?.greenAttempt ?? 1,
        resumeFrom,
        alreadyGreen: false,
      });
    }
    } catch (error: unknown) {
      runError = error;
      throw error;
    } finally {
      this.saveImplReviewData(
        logger,
        plan,
        reviewOrchestrator.getRecords(),
        { greenAttempts: greenAttempt, alreadyGreen },
        runError ? "failed" : "completed",
        runError ? this.buildReviewDataErrorMeta(runError) : undefined,
      );
    }
  }

  private async lintCheck(
    lintGuard: LintGuard, scope: string, phase: string,
    options?: { scopeTools?: string[]; root?: string },
  ): Promise<void> {
    console.log(`リントチェック中（${phase}）...`);
    const sourceFiles = await this.boundary.findSourceFiles(scope);
    if (sourceFiles.length === 0) return;

    const claudeFix = options?.scopeTools
      ? async (violations: LintViolation[]) => {
          const issueList = violations
            .map((v) => `${v.tool}: ${v.file}:${v.line} - ${v.message}`)
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
                allowedTools: options.scopeTools,
                cwd: options.root,
              },
              this.profile,
              FLOW_STEP.LINT_FIX,
              this.boundary.getProjectRoot(),
            ),
            undefined,
          );
        }
      : undefined;

    await lintGuard.check(sourceFiles, {
      claudeFix,
    });
  }

  private async runTestReview(
    orchestrator: ReviewOrchestrator,
    plan: ValidatedImplPlan,
    testPath: string,
    options?: { skipExternalReview?: boolean },
  ): Promise<void> {
    const testFiles = await this.boundary.findChangedTestFiles(plan.scope);
    if (testFiles.length === 0) return;

    console.log("テストレビュー実行中...");
    await orchestrator.runReview({
      targetFiles: testFiles,
      specPath: plan.resolvedPaths.specPath,
      criteriaPaths: [],
      runTests: async () => {
        const result = await this.runTests(testPath);
        if (!result.passed) {
          throw new HarnessError(`テスト失敗: ${result.output}`);
        }
      },
      rescanFiles: () => this.boundary.findChangedTestFiles(plan.scope),
      scopeAllowedTools: this.boundary.testAllowedTools(plan.scope),
      getFileDiff: (files: string[]) => this.boundary.getFileDiff(files),
      reviewMode: "test",
      targetTestCases: plan.targetTestCases,
      skipExternalReview: options?.skipExternalReview,
      testCasesPath: plan.resolvedPaths.testCasesPath,
    });
  }

  private async reconcileGeneratedTestsPlacement(
    scope: string,
    testPath: string,
    decision: "noop" | "updated" | "contract_revision_required",
  ): Promise<void> {
    let expectedTests = await this.boundary.findTestFiles(scope);
    const misplacedTests = await this.boundary.findMisplacedTestFiles(scope);

    if (decision === "updated" && misplacedTests.length > 0) {
      const absTestDir = resolve(this.boundary.getProjectRoot(), testPath);
      mkdirSync(absTestDir, { recursive: true });

      for (const misplaced of misplacedTests) {
        const destination = join(absTestDir, basename(misplaced));
        if (misplaced === destination) continue;
        if (existsSync(destination)) {
          throw new GuardError(
            `期待ディレクトリへのテスト移動先が既に存在します: ${destination}`,
          );
        }
        renameSync(misplaced, destination);
      }

      expectedTests = await this.boundary.findTestFiles(scope);
    }

    if (expectedTests.length === 0) {
      const misplacedNote = misplacedTests.length > 0
        ? `\n期待外の場所に生成されたテスト候補:\n${misplacedTests.join("\n")}`
        : "";
      throw new GuardError(
        `生成されたテストが期待ディレクトリに存在しません。期待パス: ${testPath}${misplacedNote}`,
      );
    }
  }

  private async runImplReview(
    orchestrator: ReviewOrchestrator,
    plan: ValidatedImplPlan,
    criteriaPaths: string[],
    testPath: string,
  ): Promise<void> {
    const implFiles = await this.boundary.findChangedImplementationFiles(plan.scope);
    if (implFiles.length === 0) return;

    console.log("実装レビュー実行中...");
    await orchestrator.runReview({
      targetFiles: implFiles,
      specPath: plan.resolvedPaths.specPath,
      criteriaPaths,
      runTests: async () => {
        const result = await this.runTests(testPath);
        if (!result.passed) {
          throw new HarnessError(`テスト失敗: ${result.output}`);
        }
      },
      rescanFiles: () => this.boundary.findChangedImplementationFiles(plan.scope),
      scopeAllowedTools: this.boundary.implAllowedTools(plan.scope),
      getFileDiff: (files: string[]) => this.boundary.getFileDiff(files),
      designDecisions: plan.designDecisions,
      reviewMode: "implementation",
    });
  }

  private async resumeImplReviewFromCheckpoint(options: {
    reviewOrchestrator: ReviewOrchestrator;
    plan: ValidatedImplPlan;
    criteriaPaths: string[];
    testPath: string;
    logger: Logger;
    planPath: string;
    sessionId: string;
    testGenerationDecision: "noop" | "updated" | "contract_revision_required";
    greenAttempt: number;
    resumeFrom: CompletedStep | null;
    alreadyGreen: boolean;
  }): Promise<void> {
    const { reviewOrchestrator, plan, criteriaPaths, testPath, logger } = options;
    const implFiles = await this.boundary.findChangedImplementationFiles(plan.scope);
    if (implFiles.length === 0) {
      this.generateReport(plan, logger, reviewOrchestrator.getRecords(), {
        greenAttempts: options.greenAttempt,
        alreadyGreen: options.alreadyGreen,
      });
      logger.clearCheckpoint();
      console.log("完了しました。");
      return;
    }

    const reviewParams = {
      targetFiles: implFiles,
      specPath: plan.resolvedPaths.specPath,
      criteriaPaths,
      runTests: async () => {
        const result = await this.runTests(testPath);
        if (!result.passed) {
          throw new HarnessError(`テスト失敗: ${result.output}`);
        }
      },
      rescanFiles: () => this.boundary.findChangedImplementationFiles(plan.scope),
      scopeAllowedTools: this.boundary.implAllowedTools(plan.scope),
      getFileDiff: (files: string[]) => this.boundary.getFileDiff(files),
      designDecisions: plan.designDecisions,
      reviewMode: "implementation" as const,
    };

    if (!this.shouldSkip(options.resumeFrom, "impl_review_criteria_passed")) {
      console.log("実装レビュー実行中... (criteria)");
      await reviewOrchestrator.runImplementationCriteriaReview(reviewParams);
      this.saveImplCheckpoint(logger, {
        planPath: options.planPath,
        completedStep: "impl_review_criteria_passed",
        sessionId: options.sessionId,
        testGenerationDecision: options.testGenerationDecision,
        greenAttempt: options.greenAttempt,
        records: reviewOrchestrator.getRecords(),
      });
    }

    if (!this.shouldSkip(options.resumeFrom, "impl_review_quality_passed")) {
      console.log("実装レビュー実行中... (quality)");
      await reviewOrchestrator.runImplementationQualityReview(reviewParams);
      this.saveImplCheckpoint(logger, {
        planPath: options.planPath,
        completedStep: "impl_review_quality_passed",
        sessionId: options.sessionId,
        testGenerationDecision: options.testGenerationDecision,
        greenAttempt: options.greenAttempt,
        records: reviewOrchestrator.getRecords(),
      });
    }

    if (!this.shouldSkip(options.resumeFrom, "impl_reviewed")) {
      console.log("実装レビュー実行中... (external)");
      await reviewOrchestrator.runImplementationExternalReview(reviewParams);
      this.saveImplCheckpoint(logger, {
        planPath: options.planPath,
        completedStep: "impl_reviewed",
        sessionId: options.sessionId,
        testGenerationDecision: options.testGenerationDecision,
        greenAttempt: options.greenAttempt,
        records: reviewOrchestrator.getRecords(),
      });
    }

    this.generateReport(plan, logger, reviewOrchestrator.getRecords(), {
      greenAttempts: options.greenAttempt,
      alreadyGreen: options.alreadyGreen,
    });
    logger.clearCheckpoint();
    console.log("完了しました。");
  }

  private saveImplCheckpoint(
    logger: Logger,
    options: {
      planPath: string;
      completedStep: CompletedStep;
      sessionId: string;
      testGenerationDecision: "noop" | "updated" | "contract_revision_required";
      greenAttempt: number;
      records: ReviewRecord[];
    },
  ): void {
    logger.saveCheckpoint({
      planPath: options.planPath,
      completedStep: options.completedStep,
      sessionId: options.sessionId,
      testGenerationDecision: options.testGenerationDecision,
      records: options.records,
      greenAttempt: options.greenAttempt,
      timestamp: new Date().toISOString(),
    });
  }

  private async runTests(
    testPath: string,
    options?: { allowCollectionError?: boolean },
  ): Promise<{ passed: boolean; output: string }> {
    // test tool の cwd を `toolRoot` へ寄せても、対象パス解決だけはブレさせない。
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
        if (options?.allowCollectionError) {
          return { passed: false, output: testResult.output };
        }
        throw new GuardError(
          `${this.testAdapter.frameworkName} がコレクションエラーで終了しました。環境を確認してください。\n${testResult.output}`,
        );
      case "no-tests":
        throw new GuardError(
          `${this.testAdapter.frameworkName} がテスト未検出で終了しました。テストパスを確認してください。`,
        );
      case "internal-error":
      case "interrupted":
        throw new GuardError(
          `${this.testAdapter.frameworkName} が内部エラーで終了しました (exit ${testResult.exitCode})。\n${testResult.output}`,
        );
    }
  }

  private generateReport(
    plan: ValidatedImplPlan,
    logger: Logger,
    records: ReviewRecord[],
    tdd: { greenAttempts: number; alreadyGreen: boolean },
  ): void {
    const root = this.boundary.getProjectRoot();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const scopeSlug = plan.scope.replace(/\//g, "_");
    const usageSummary = logger.summarizeRunnerUsage();

    // MD レポート生成
    // 集計対象: accepted を除いたレビュー実行レコードのみ
    const activeRecords = records.filter(
      (r) => r.step !== "design_decision" && r.decision !== "accepted",
    );
    const fixedRecords = activeRecords.filter((r) => r.decision === "fixed");
    const lgtmRecords = activeRecords.filter((r) => r.decision === "lgtm");
    const acceptedRecords = records.filter((r) => r.decision === "accepted");
    // レビューステップ数（ユニークな step で数える）
    const reviewSteps = [...new Set(activeRecords.map((r) => r.step))].length;
    // レビューサイクル総数（修正による再実行を含む）
    const totalCycles = activeRecords.length;
    // 修正した指摘の総件数（record 数ではなく issue 数）
    const fixCount = fixedRecords.reduce((sum, r) => sum + r.findings.length, 0);

    let md = `# タスクレポート: ${plan.scope}

**実行日**: ${timestamp}
**スコープ**: ${plan.scope}
**結果**: 完了
**レビューサイクル数**: ${totalCycles}回
**修正件数**: ${fixCount}件
**Claude実行回数**: ${usageSummary.total.runs}回

## 対象テストケース
${plan.targetTestCases.map((tc, i) => `${i + 1}. ${tc}`).join("\n")}

## TDD サイクル
`;

    if (tdd.alreadyGreen) {
      md += `- テスト生成後、既に GREEN（実装生成スキップ）\n`;
    } else {
      md += `- 実装生成: ${tdd.greenAttempts}回目で GREEN（最大3回）\n`;
    }

    md += `\n---\n\n## レビュー詳細\n\n`;

    // ステップごとにグループ化（design_decision と accepted は別セクションで出力）
    const displayRecords = records.filter(
      (r) => r.step !== "design_decision" && r.decision !== "accepted",
    );
    const steps = [...new Set(displayRecords.map((r) => r.step))];
    for (const step of steps) {
      const stepRecords = displayRecords.filter((r) => r.step === step);
      md += `### ${step}\n\n`;

      for (const record of stepRecords) {
        if (record.decision === "lgtm") {
          md += `指摘なし（${record.cycle}回目で通過）\n\n`;
        } else if (record.decision === "fixed") {
          // 指摘一覧
          for (const issue of record.findings) {
            md += `- [${issue.severity}] ${issue.file}${issue.line ? `:${issue.line}` : ""} — ${redact(issue.description)}\n`;
          }
          // diff（サイクルあたり1回）
          if (record.diffAfter) {
            const snippet = redact(record.diffAfter.split("\n").slice(0, 30).join("\n"));
            if (snippet.trim()) {
              md += `\n<details><summary>修正 diff</summary>\n\n\`\`\`diff\n${snippet}\n\`\`\`\n</details>\n`;
            }
          }
          md += `\n`;
        } else if (record.decision === "escalated") {
          md += `**エスカレーション**: 自動修正で解決できませんでした。\n\n`;
        }
      }
    }

    // 設計判断セクション
    if (plan.designDecisions.length > 0) {
      md += `---\n\n## 事前定義の設計判断\n\n`;
      for (const decision of plan.designDecisions) {
        md += `- ${redact(decision)}\n`;
      }
      md += `\n`;
    }

    const reviewAcceptedRecords = acceptedRecords;
    if (reviewAcceptedRecords.length > 0) {
      md += `---\n\n## レビュー中に許容した指摘\n\n`;
      for (const record of reviewAcceptedRecords) {
        for (const issue of record.findings) {
          md += `#### ${redact(issue.description)}（${issue.severity}）\n`;
          md += `- **ファイル**: ${issue.file}${issue.line ? `:${issue.line}` : ""}\n`;
          md += `- **判断**: 許容\n`;
          md += `\n`;
        }
      }
    }

    // サマリー
    md += `---\n\n## サマリー\n\n`;
    md += `| 指標 | 値 |\n|---|---|\n`;
    md += `| レビューステップ数 | ${reviewSteps} |\n`;
    md += `| レビューサイクル総数 | ${totalCycles}回（修正による再実行を含む） |\n`;
    md += `| 修正した指摘数 | ${fixCount}件 |\n`;
    md += `| 通過ステップ数 | ${lgtmRecords.length}件 |\n`;
    md += `| 事前定義の設計判断 | ${plan.designDecisions.length}件 |\n`;
    md += `| レビュー中に許容 | ${reviewAcceptedRecords.length}件 |\n`;
    md += `| Claude実行回数 | ${usageSummary.total.runs}件 |\n`;
    md += `| Input Tokens | ${usageSummary.total.inputTokens} |\n`;
    md += `| Output Tokens | ${usageSummary.total.outputTokens} |\n`;
    md += `| Cost USD | ${usageSummary.total.costUsd.toFixed(4)} |\n`;

    const usageSteps = Object.entries(usageSummary.byStep) as Array<[
      string,
      { runs: number; inputTokens: number; outputTokens: number; costUsd: number },
    ]>;
    if (usageSteps.length > 0) {
      md += `\n### Claude Usage By Step\n\n`;
      md += `| Step | Runs | Input | Output | Cost USD |\n|---|---:|---:|---:|---:|\n`;
      for (const [step, totals] of usageSteps) {
        md += `| ${step} | ${totals.runs} | ${totals.inputTokens} | ${totals.outputTokens} | ${totals.costUsd.toFixed(4)} |\n`;
      }
    }

    // 書き出し
    const reportsDir = join(root, ".harness/reviews");
    mkdirSync(reportsDir, { recursive: true });
    const reportPath = join(reportsDir, `${timestamp}_${scopeSlug}.md`);
    writeFileSync(reportPath, md, "utf-8");
    console.log(`レポート生成: ${reportPath}`);
  }

  private saveImplReviewData(
    logger: Logger,
    plan: ValidatedImplPlan,
    records: ReviewRecord[],
    tdd: { greenAttempts: number; alreadyGreen: boolean },
    status: ReviewDataStatus,
    error?: ReviewDataErrorMeta,
  ): void {
    const payload: ImplReviewData = {
      plan,
      records,
      tdd,
      usageSummary: logger.summarizeRunnerUsage(),
      status,
      ...(error ? { error } : {}),
    };
    logger.saveReviewData(payload);
  }

  private buildReviewDataErrorMeta(error: unknown): ReviewDataErrorMeta {
    if (error instanceof DriftError) {
      return {
        name: error.name,
        message: error.message,
        metric: error.metric,
        level: error.level,
      };
    }
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
      };
    }
    return {
      name: "UnknownError",
      message: String(error),
    };
  }
}
