import { readFileSync } from "node:fs";
import type { LintGuard } from "./lint-guard.ts";
import type { RunnerRegistry } from "../../infrastructure/runners/runner-registry.ts";
import type { ResolvedProfileConfig } from "../../infrastructure/config/config.ts";
import type { FlowStep } from "../../domain/model/steps.ts";
import { FLOW_STEP } from "../../domain/model/steps.ts";
import { DriftError, HarnessError, RunnerRateLimitError, ESCALATION_LEVEL, EVENT } from "../../domain/model/types.ts";
import type { ReviewChecklistEntry, ReviewIssue, ReviewResult, ReviewRecord } from "../../domain/model/types.ts";
import type { LintViolation } from "../../domain/model/types.ts";
import { loadTemplate, renderTemplate } from "../../infrastructure/templates/templates.ts";
import { applyStepContext } from "../../infrastructure/runners/step-context.ts";
import type { Logger } from "../ports/logger.ts";
import { nextMinorOnlyCycles, shouldAcceptMinorVerdict, shouldJudgeMinorAcceptance } from "../policies/review-acceptance-policy.ts";
import { RETRY_POLICY } from "../policies/retry-policy.ts";
import { hasCriticalOrMajorIssues, hasParseFailure, reconcileReviewIssues } from "../policies/review-issue-policy.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["checklist", "issues"],
  properties: {
    checklist: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "verdict", "evidence"],
        properties: {
          item: { type: "string" },
          verdict: { enum: ["pass", "fail", "n/a"] },
          evidence: { type: "string" },
        },
      },
    },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "line", "severity", "description"],
        properties: {
          file: { type: "string" },
          line: { type: ["number", "null"] },
          severity: { enum: ["critical", "major", "minor"] },
          description: { type: "string" },
        },
      },
    },
  },
} as const;

const MINOR_ACCEPTANCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["safe", "reason"],
  properties: {
    safe: { type: "boolean" },
    reason: { type: "string" },
  },
} as const;

type ReviewParams = {
  targetFiles: string[];
  specPath: string;
  criteriaPaths: string[];
  runTests?: () => Promise<void>;
  rescanFiles?: () => Promise<string[]>;
  scopeAllowedTools: string[];
  getFileDiff?: (files: string[]) => Promise<string>;
  designDecisions?: string[];
  reviewMode: "test" | "implementation";
  targetTestCases?: string[];
  skipExternalReview?: boolean;
  testCasesPath?: string;
};

type PageReviewParams = ReviewParams & {
  componentSpecPath: string;
  figmaSlice: string;
  dependenciesText: string;
  browserScenariosText: string;
};

export class ReviewOrchestrator {
  private logger: Logger;
  private lintGuard: LintGuard;
  private projectRoot: string;
  private registry: RunnerRegistry;
  private profile?: ResolvedProfileConfig;
  private records: ReviewRecord[] = [];

  constructor(
    logger: Logger,
    lintGuard: LintGuard,
    projectRoot: string,
    registry: RunnerRegistry,
    profile?: ResolvedProfileConfig,
  ) {
    this.logger = logger;
    this.lintGuard = lintGuard;
    this.projectRoot = projectRoot;
    this.registry = registry;
    this.profile = profile;
  }

  getRecords(): ReviewRecord[] {
    return [...this.records];
  }

  restoreRecords(records: ReviewRecord[]): void {
    this.records = [...records];
  }

  async runReview(params: ReviewParams): Promise<ReviewResult[]> {
    // テストレビューは records をリセット、実装レビューは追記
    if (params.reviewMode === "test") {
      this.records = [];
    }
    const results: ReviewResult[] = [];

    if (params.reviewMode === "test") {
      return this.runTestReview(params, results);
    }
    return this.runImplementationReview(params, results);
  }

  async runPageReview(params: PageReviewParams): Promise<ReviewResult[]> {
    const results: ReviewResult[] = [];
    let minorOnlyCycles = 0;

    this.logger.log(EVENT.REVIEW_START, { mode: "page-3-step" });

    for (let cycle = 0; cycle < RETRY_POLICY.review.maxCycles; cycle++) {
      const diffBefore = params.getFileDiff
        ? await params.getFileDiff(params.targetFiles)
        : "";

      const cycleResults = [
        await this.pageDesignReview(
          params.targetFiles,
          params.specPath,
          params.componentSpecPath,
          params.dependenciesText,
          params.figmaSlice,
        ),
        await this.pageBehaviorReview(
          params.targetFiles,
          params.specPath,
          params.browserScenariosText,
        ),
        await this.pageCodeReview(
          params.targetFiles,
          params.criteriaPaths,
        ),
      ];
      results.push(...cycleResults);

      const combinedIssues = cycleResults.flatMap((result) => result.issues);
      if (combinedIssues.length === 0) {
        this.records.push({
          step: "page_review",
          cycle: cycle + 1,
          reviewer: "page_review",
          findings: [],
          decision: "lgtm",
          diffBefore,
          diffAfter: "",
          judgmentSummary: "指摘なし",
        });
        return results;
      }

      if (hasParseFailure(combinedIssues)) {
        this.records.push({
          step: "page_review",
          cycle: cycle + 1,
          reviewer: "page_review",
          findings: combinedIssues,
          decision: "escalated",
          diffBefore,
          diffAfter: "",
          judgmentSummary: "ページレビュー結果のパースに失敗。人間の確認が必要。",
        });
        throw new DriftError(
          ESCALATION_LEVEL.LEVEL_3,
          "page_review_parse_failure",
          "ページレビュー結果のパースに失敗しました。人間の確認が必要です。",
        );
      }

      minorOnlyCycles = nextMinorOnlyCycles(minorOnlyCycles, combinedIssues);
      if (!hasCriticalOrMajorIssues(combinedIssues)) {
        if (shouldJudgeMinorAcceptance(minorOnlyCycles)) {
          const verdict = await this.judgeMinorAcceptance(
            combinedIssues,
            diffBefore,
            params.specPath,
          );
          if (shouldAcceptMinorVerdict(minorOnlyCycles, verdict)) {
            this.records.push({
              step: "page_review",
              cycle: cycle + 1,
              reviewer: "page_review",
              findings: combinedIssues,
              decision: "accepted",
              diffBefore,
              diffAfter: "",
              judgmentSummary: verdict.reason,
            });
            return results;
          }
        }
      }

      await this.applyFixes(combinedIssues, params);
      const diffAfter = params.getFileDiff
        ? await params.getFileDiff(params.targetFiles)
        : "";
      const judgmentSummary = await this.generateJudgmentSummary(combinedIssues, diffBefore, diffAfter);
      this.records.push({
        step: "page_review",
        cycle: cycle + 1,
        reviewer: "page_review",
        findings: combinedIssues,
        decision: "fixed",
        diffBefore,
        diffAfter,
        judgmentSummary,
      });
    }

    throw new DriftError(
      ESCALATION_LEVEL.LEVEL_1,
      "page_review_cycle",
      `ページレビューが ${RETRY_POLICY.review.maxCycles} サイクルで収束しませんでした`,
    );
  }

  async runComponentReview(
    targetFiles: string[],
    criteriaPaths: string[],
  ): Promise<ReviewResult> {
    const fileContents = this.readFiles(targetFiles);
    const criteria = criteriaPaths.map((p) => readFileSync(p, "utf-8")).join("\n\n");
    const config = this.registry.getConfig();
    const template = loadTemplate("review-impl-criteria", this.projectRoot, config.templates);
    const responseFormat = loadTemplate("review-response-format", this.projectRoot, config.templates);
    const prompt = renderTemplate(template, { fileContents, responseFormat });
    return this.executeReview(
      FLOW_STEP.COMPONENT_SELF_REVIEW,
      prompt,
      "component_self_review",
      { appendSystemPrompt: criteria },
    );
  }

  private async runTestReview(
    params: ReviewParams,
    results: ReviewResult[],
  ): Promise<ReviewResult[]> {
    this.logger.log(EVENT.REVIEW_START, {
      mode: params.skipExternalReview || this.registry.isStepSkipped(FLOW_STEP.TEST_EXTERNAL_REVIEW)
        ? "test-1-step"
        : "test-2-step",
    });

    // Step 1: テスト品質チェック（テストケース文書との整合性）
    const step1Result = await this.reviewStep(
      () => this.selfReviewTestQuality(
        params.targetFiles, params.specPath, params.testCasesPath ?? "", params.targetTestCases ?? [],
      ),
      params,
    );
    results.push(step1Result);

    // Step 2: 外部レビュー（テストデータの妥当性）
    if (params.skipExternalReview || this.registry.isStepSkipped(FLOW_STEP.TEST_EXTERNAL_REVIEW)) {
      // light フロー: 外部レビューをスキップ
    } else {
      try {
        const step2Result = await this.reviewStep(
          () => this.externalTestReview(
            params.targetFiles,
            params.specPath,
            params.testCasesPath ?? "",
            params.targetTestCases ?? [],
            params.getFileDiff,
          ),
          params,
        );
        results.push(step2Result);
      } catch (error: unknown) {
        if (error instanceof RunnerRateLimitError) {
          this.logger.log(EVENT.RUNNER_RATE_LIMITED, { fallback: "dual_fallback", runner: error.runnerName });
          const dualResult = await this.runDualStep(params);
          results.push(...dualResult);
        } else {
          throw error;
        }
      }
    }

    return results;
  }

  private async runImplementationReview(
    params: ReviewParams,
    results: ReviewResult[],
  ): Promise<ReviewResult[]> {
    this.logger.log(EVENT.REVIEW_START, {
      mode: this.registry.isStepSkipped(FLOW_STEP.IMPL_EXTERNAL_REVIEW) ? "impl-2-step" : "impl-3-step",
    });

    // Step 1: セルフレビュー（レビュー観点チェック）
    const step1Result = await this.reviewStep(
      () => this.selfReviewCriteria(params.targetFiles, params.criteriaPaths),
      params,
    );
    results.push(step1Result);

    // Step 2: セルフレビュー（品質チェック）
    const step2Result = await this.reviewStep(
      () => this.selfReviewQuality(params.targetFiles, params.specPath),
      params,
    );
    results.push(step2Result);

    // Step 3: 外部レビュー
    if (this.registry.isStepSkipped(FLOW_STEP.IMPL_EXTERNAL_REVIEW)) {
      // light フロー: 外部レビューをスキップ
    } else {
      try {
        const step3Result = await this.reviewStep(
          () => this.externalImplementationReview(params.targetFiles, params.specPath, params.getFileDiff),
          params,
        );
        results.push(step3Result);
      } catch (error: unknown) {
        if (error instanceof RunnerRateLimitError) {
          this.logger.log(EVENT.RUNNER_RATE_LIMITED, { fallback: "dual_fallback", runner: error.runnerName });
          const dualResult = await this.runDualStep(params);
          results.push(...dualResult);
        } else {
          throw error;
        }
      }
    }

    // 設計判断を accepted として記録
    if (params.designDecisions) {
      for (const decision of params.designDecisions) {
        this.records.push({
          step: "design_decision",
          cycle: 0,
          reviewer: "plan",
          findings: [],
          decision: "accepted",
          diffBefore: "",
          diffAfter: "",
          judgmentSummary: decision,
        });
      }
    }

    return results;
  }

  private async runDualStep(params: ReviewParams): Promise<ReviewResult[]> {
    const results: ReviewResult[] = [];
    let cycle = 0;

    while (cycle < RETRY_POLICY.review.maxCycles) {
      cycle++;
      const diffBefore = params.getFileDiff
        ? await params.getFileDiff(params.targetFiles)
        : "";

      const [reviewA, reviewB] = await this.dualFallbackReview(
        params.targetFiles,
        params.specPath,
        params.reviewMode === "test" ? params.testCasesPath : undefined,
        params.reviewMode === "test"
          ? {
              targetTestCases: params.targetTestCases,
              changedHunks: diffBefore,
            }
          : undefined,
      );

      this.logger.log(EVENT.FALLBACK_REVIEW, {
        agent: "A",
        issues: reviewA.issues.length,
      });
      this.logger.log(EVENT.FALLBACK_REVIEW, {
        agent: "B",
        issues: reviewB.issues.length,
      });

      // パース失敗チェック（両エージェント）
      const combinedIssues = [...reviewA.issues, ...reviewB.issues];
      if (hasParseFailure(combinedIssues)) {
        this.records.push({
          step: "dual_fallback",
          cycle,
          reviewer: "fallback_a+fallback_b",
          findings: combinedIssues,
          decision: "escalated",
          diffBefore,
          diffAfter: "",
          judgmentSummary: "2体レビューの結果パースに失敗。人間のエスカレーションが必要。",
        });
        throw new DriftError(
          ESCALATION_LEVEL.LEVEL_3,
          "review_parse_failure",
          `2体レビューの結果パースに失敗しました。人間の確認が必要です。`,
        );
      }

      const toFix = this.reconcileReviews(reviewA, reviewB);

      if (toFix.length === 0) {
        this.records.push({
          step: "dual_fallback",
          cycle,
          reviewer: "fallback_a+fallback_b",
          findings: [],
          decision: "lgtm",
          diffBefore,
          diffAfter: "",
          judgmentSummary: "指摘なし",
        });
        results.push(reviewA, reviewB);
        return results;
      }

      this.logger.log(EVENT.REVIEW_RECONCILED, {
        toFix: toFix.length,
        cycle,
      });

      await this.applyFixes(toFix, params);

      const diffAfter = params.getFileDiff
        ? await params.getFileDiff(params.targetFiles)
        : "";
      const judgmentSummary = await this.generateJudgmentSummary(toFix, diffBefore, diffAfter);

      this.records.push({
        step: "dual_fallback",
        cycle,
        reviewer: "fallback_a+fallback_b",
        findings: toFix,
        decision: "fixed",
        diffBefore,
        diffAfter,
        judgmentSummary,
      });
    }

    throw new DriftError(
      ESCALATION_LEVEL.LEVEL_1,
      "review_cycle",
      `レビューが ${RETRY_POLICY.review.maxCycles} サイクルで収束しませんでした`,
    );
  }

  private async selfReviewTestQuality(
    targetFiles: string[],
    specPath: string,
    testCasesPath: string,
    targetTestCases: string[],
  ): Promise<ReviewResult> {
    const fileContents = this.readFiles(targetFiles);
    const spec = readFileSync(specPath, "utf-8");
    const testCases = testCasesPath ? readFileSync(testCasesPath, "utf-8") : "";
    const config = this.registry.getConfig();
    const responseFormat = loadTemplate("review-response-format", this.projectRoot, config.templates);
    const template = loadTemplate("review-test-quality", this.projectRoot, config.templates);
    const prompt = renderTemplate(template, {
      fileContents,
      testCases,
      targetTestCases: targetTestCases.join("\n"),
      spec,
      responseFormat,
    });

    this.logger.log(EVENT.SELF_REVIEW, { step: "test_quality" });
    return this.executeReview(FLOW_STEP.TEST_SELF_QUALITY, prompt, "test_self_quality", {
      outputSchema: REVIEW_OUTPUT_SCHEMA,
    });
  }

  private async selfReviewCriteria(
    targetFiles: string[],
    criteriaPaths: string[],
  ): Promise<ReviewResult> {
    const fileContents = this.readFiles(targetFiles);
    const criteria = criteriaPaths
      .map((p) => readFileSync(p, "utf-8"))
      .join("\n\n");
    const config = this.registry.getConfig();
    const responseFormat = loadTemplate("review-response-format", this.projectRoot, config.templates);
    const template = loadTemplate("review-impl-criteria", this.projectRoot, config.templates);
    const prompt = renderTemplate(template, { fileContents, responseFormat });

    this.logger.log(EVENT.SELF_REVIEW, { step: "criteria" });
    // Pass criteria as appendSystemPrompt option
    return this.executeReview(FLOW_STEP.IMPL_SELF_CRITERIA, prompt, "self_criteria", {
      appendSystemPrompt: criteria,
      outputSchema: REVIEW_OUTPUT_SCHEMA,
    });
  }

  private async selfReviewQuality(
    targetFiles: string[],
    specPath: string,
  ): Promise<ReviewResult> {
    const fileContents = this.readFiles(targetFiles);
    const spec = readFileSync(specPath, "utf-8");
    const config = this.registry.getConfig();
    const responseFormat = loadTemplate("review-response-format", this.projectRoot, config.templates);
    const template = loadTemplate("review-impl-quality", this.projectRoot, config.templates);
    const prompt = renderTemplate(template, { fileContents, spec, responseFormat });

    this.logger.log(EVENT.SELF_REVIEW, { step: "quality" });
    return this.executeReview(FLOW_STEP.IMPL_SELF_QUALITY, prompt, "self_quality", {
      outputSchema: REVIEW_OUTPUT_SCHEMA,
    });
  }

  private async externalTestReview(
    targetFiles: string[],
    specPath: string,
    testCasesPath: string,
    targetTestCases: string[],
    getFileDiff?: (files: string[]) => Promise<string>,
  ): Promise<ReviewResult> {
    const config = this.registry.getConfig();
    const responseFormat = loadTemplate("review-response-format", this.projectRoot, config.templates);
    const template = loadTemplate("review-external-test", this.projectRoot, config.templates);
    const changedHunks = getFileDiff ? await getFileDiff(targetFiles) : "";
    const prompt = renderTemplate(template, {
      targetFiles: targetFiles.join("\n"),
      changedHunks: changedHunks || "(差分なし)",
      targetTestCases: targetTestCases.join("\n"),
      specPath,
      testCasesPath,
      responseFormat,
    });

    return this.executeReview(FLOW_STEP.TEST_EXTERNAL_REVIEW, prompt, "test_external", {
      outputSchema: REVIEW_OUTPUT_SCHEMA,
    });
  }

  private async externalImplementationReview(
    targetFiles: string[],
    specPath: string,
    getFileDiff?: (files: string[]) => Promise<string>,
  ): Promise<ReviewResult> {
    const fileContents = this.readFiles(targetFiles);
    const spec = readFileSync(specPath, "utf-8");
    const config = this.registry.getConfig();
    const responseFormat = loadTemplate("review-response-format", this.projectRoot, config.templates);
    const template = loadTemplate("review-external-impl", this.projectRoot, config.templates);
    const changedHunks = getFileDiff ? await getFileDiff(targetFiles) : "";
    const prompt = renderTemplate(template, {
      targetFiles: targetFiles.join("\n"),
      changedHunks: changedHunks || "(差分なし)",
      fileContents,
      spec,
      responseFormat,
    });

    return this.executeReview(FLOW_STEP.IMPL_EXTERNAL_REVIEW, prompt, "impl_external", {
      outputSchema: REVIEW_OUTPUT_SCHEMA,
    });
  }

  private async pageDesignReview(
    targetFiles: string[],
    specPath: string,
    componentSpecPath: string,
    dependenciesText: string,
    figmaSlice: string,
  ): Promise<ReviewResult> {
    const fileContents = this.readFiles(targetFiles);
    const spec = readFileSync(specPath, "utf-8");
    const componentSpec = readFileSync(componentSpecPath, "utf-8");
    const config = this.registry.getConfig();
    const responseFormat = loadTemplate("review-response-format", this.projectRoot, config.templates);
    const template = loadTemplate("review-page-design", this.projectRoot, config.templates);
    const prompt = renderTemplate(template, {
      fileContents,
      spec,
      componentSpec,
      dependencies: dependenciesText,
      figmaSlice,
      responseFormat,
    });

    return this.executeReview(FLOW_STEP.PAGE_REVIEW_DESIGN, prompt, "page_design");
  }

  private async pageBehaviorReview(
    targetFiles: string[],
    specPath: string,
    browserScenariosText: string,
  ): Promise<ReviewResult> {
    const fileContents = this.readFiles(targetFiles);
    const spec = readFileSync(specPath, "utf-8");
    const config = this.registry.getConfig();
    const responseFormat = loadTemplate("review-response-format", this.projectRoot, config.templates);
    const template = loadTemplate("review-page-behavior", this.projectRoot, config.templates);
    const prompt = renderTemplate(template, {
      fileContents,
      spec,
      browserScenarios: browserScenariosText,
      responseFormat,
    });

    return this.executeReview(FLOW_STEP.PAGE_REVIEW_BEHAVIOR, prompt, "page_behavior");
  }

  private async pageCodeReview(
    targetFiles: string[],
    criteriaPaths: string[],
  ): Promise<ReviewResult> {
    const fileContents = this.readFiles(targetFiles);
    const criteria = criteriaPaths
      .map((p) => readFileSync(p, "utf-8"))
      .join("\n\n");
    const config = this.registry.getConfig();
    const responseFormat = loadTemplate("review-response-format", this.projectRoot, config.templates);
    const template = loadTemplate("review-impl-criteria", this.projectRoot, config.templates);
    const prompt = renderTemplate(template, { fileContents, responseFormat });

    return this.executeReview(
      FLOW_STEP.PAGE_REVIEW_CODE,
      prompt,
      "page_code",
      {
        appendSystemPrompt: criteria,
        outputSchema: REVIEW_OUTPUT_SCHEMA,
      },
    );
  }

  private async dualFallbackReview(
    targetFiles: string[],
    specPath: string,
    testCasesPath?: string,
    options?: {
      targetTestCases?: string[];
      changedHunks?: string;
    },
  ): Promise<[ReviewResult, ReviewResult]> {
    const config = this.registry.getConfig();
    const responseFormat = loadTemplate("review-response-format", this.projectRoot, config.templates);

    let prompt: string;
    if (testCasesPath) {
      const template = loadTemplate("review-external-test", this.projectRoot, config.templates);
      prompt = renderTemplate(template, {
        targetFiles: targetFiles.join("\n"),
        changedHunks: options?.changedHunks ?? "(差分なし)",
        targetTestCases: (options?.targetTestCases ?? []).join("\n"),
        specPath,
        testCasesPath,
        responseFormat,
      });
    } else {
      const fileContents = this.readFiles(targetFiles);
      const spec = readFileSync(specPath, "utf-8");
      const template = loadTemplate("review-dual-fallback", this.projectRoot, config.templates);
      prompt = renderTemplate(template, { fileContents, spec, responseFormat });
    }

    const fallback = this.registry.getFallbackRunner();
    const request = {
      prompt,
      allowedTools: ["Read"],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };
    const [responseA, responseB] = await Promise.all([
      fallback.run(request, this.logger),
      fallback.run(request, this.logger),
    ]);
    return [
      this.parseReviewResult("fallback_a", responseA.text),
      this.parseReviewResult("fallback_b", responseB.text),
    ];
  }

  reconcileReviews(
    a: ReviewResult,
    b: ReviewResult,
  ): ReviewIssue[] {
    const reconciled = reconcileReviewIssues(a, b);
    for (const accepted of reconciled.accepted) {
      this.records.push({
        step: "dual_fallback",
        cycle: 0,
        reviewer: accepted.reviewer,
        findings: [accepted.issue],
        decision: "accepted",
        diffBefore: "",
        diffAfter: "",
        judgmentSummary: accepted.judgmentSummary,
      });
    }
    return reconciled.toFix;
  }

  private async reviewStep(
    reviewFn: () => Promise<ReviewResult>,
    params: ReviewParams,
  ): Promise<ReviewResult> {
    let minorOnlyCycles = 0;

    for (let cycle = 0; cycle < RETRY_POLICY.review.maxCycles; cycle++) {
      const diffBefore = params.getFileDiff
        ? await params.getFileDiff(params.targetFiles)
        : "";
      const result = await reviewFn();

      if (result.isLgtm) {
        this.records.push({
          step: result.reviewer,
          cycle: cycle + 1,
          reviewer: result.reviewer,
          findings: [],
          decision: "lgtm",
          diffBefore,
          diffAfter: "",
          judgmentSummary: "指摘なし",
        });
        return result;
      }

      // パース失敗等の擬似 issue は自動修正せずエスカレーション
      if (hasParseFailure(result.issues)) {
        this.records.push({
          step: result.reviewer,
          cycle: cycle + 1,
          reviewer: result.reviewer,
          findings: result.issues,
          decision: "escalated",
          diffBefore,
          diffAfter: "",
          judgmentSummary: "レビュー結果のパースに失敗。人間のエスカレーションが必要。",
        });
        throw new DriftError(
          ESCALATION_LEVEL.LEVEL_3,
          "review_parse_failure",
          `レビュー結果のパースに失敗しました（reviewer: ${result.reviewer}）。人間の確認が必要です。`,
        );
      }

      minorOnlyCycles = nextMinorOnlyCycles(minorOnlyCycles, result.issues);
      if (!hasCriticalOrMajorIssues(result.issues)) {
        if (shouldJudgeMinorAcceptance(minorOnlyCycles)) {
          // 第三者 Claude に許容可否を判断させる
          const verdict = await this.judgeMinorAcceptance(
            result.issues, diffBefore, params.specPath,
          );
          if (shouldAcceptMinorVerdict(minorOnlyCycles, verdict)) {
            for (const issue of result.issues) {
              this.records.push({
                step: result.reviewer,
                cycle: cycle + 1,
                reviewer: result.reviewer,
                findings: [issue],
                decision: "accepted",
                diffBefore,
                diffAfter: "",
                judgmentSummary: verdict.reason,
              });
            }
            return result;
          }
          // unsafe → 修正を再試行（1回のみ）
          await this.applyFixes(result.issues, params);
          const retryResult = await reviewFn();
          const diffAfterRetry = params.getFileDiff
            ? await params.getFileDiff(params.targetFiles)
            : "";
          if (retryResult.isLgtm) {
            this.records.push({
              step: result.reviewer,
              cycle: cycle + 2,
              reviewer: result.reviewer,
              findings: [],
              decision: "lgtm",
              diffBefore,
              diffAfter: diffAfterRetry,
              judgmentSummary: `第三者判断により修正: ${verdict.reason}`,
            });
            return retryResult;
          }
          // 修正後も残存 → escalated
          this.records.push({
            step: result.reviewer,
            cycle: cycle + 2,
            reviewer: result.reviewer,
            findings: retryResult.issues,
            decision: "escalated",
            diffBefore,
            diffAfter: diffAfterRetry,
            judgmentSummary: `${verdict.reason}（修正後も残存）`,
          });
          return retryResult;
        }
      }

      await this.applyFixes(result.issues, params);

      const diffAfter = params.getFileDiff
        ? await params.getFileDiff(params.targetFiles)
        : "";

      // 判断理由を生成
      const judgmentSummary = await this.generateJudgmentSummary(result.issues, diffBefore, diffAfter);

      this.records.push({
        step: result.reviewer,
        cycle: cycle + 1,
        reviewer: result.reviewer,
        findings: result.issues,
        decision: "fixed",
        diffBefore,
        diffAfter,
        judgmentSummary,
      });
    }

    throw new DriftError(
      ESCALATION_LEVEL.LEVEL_1,
      "review_cycle",
      `レビューが ${RETRY_POLICY.review.maxCycles} サイクルで収束しませんでした`,
    );
  }

  private async applyFixes(
    issues: ReviewIssue[],
    params: ReviewParams,
  ): Promise<void> {
    const issueList = issues
      .map(
        (i, idx) =>
          `${idx + 1}. [${i.severity}] ${i.file}:${i.line ?? "?"} - ${i.description}`,
      )
      .join("\n");

    const hasBugFix = issues.some(
      (i) => i.severity === "critical" || i.severity === "major",
    );
    const constraint = hasBugFix
      ? `- バグ修正の場合は振る舞いの変更を許可する
- 仕様書に記載された振る舞いに合致させること
- 既存テストが壊れた場合はテストも修正する`
      : `- 指摘された箇所のみ修正
- 既存テストを壊さない
- 振る舞いを変えない（リファクタリングのみ）`;

    const prompt = `以下のレビュー指摘を修正してください。

## 指摘一覧
${issueList}

## 制約
${constraint}`;

    await this.executeRun(FLOW_STEP.APPLY_FIXES, prompt, {
      allowedTools: params.scopeAllowedTools,
      cwd: this.projectRoot,
    });

    // 修正でファイルが追加された可能性があるので再スキャン
    if (params.rescanFiles) {
      params.targetFiles = await params.rescanFiles();
    }

    // 対象ファイルが空ならリントをスキップ（全体に広がるのを防止）
    if (params.targetFiles.length > 0) {
      await this.lintGuard.check(params.targetFiles, {
        claudeFix: async (violations: LintViolation[]) => {
          const lintIssueList = violations
            .map((violation, idx) =>
              `${idx + 1}. ${violation.tool}: ${violation.file}:${violation.line} - ${violation.message}`,
            )
            .join("\n");
          const runner = this.registry.getRunner(FLOW_STEP.LINT_FIX);
          await runner.run(
            applyStepContext(
              {
                prompt: `以下のリンター違反を修正してください。自動修正できなかった違反です。

## 違反一覧
${lintIssueList}

## 制約
- 指摘された違反のみ修正する
- 既存のロジックや振る舞いを不必要に変更しない`,
                allowedTools: params.scopeAllowedTools,
                cwd: this.projectRoot,
                timeoutMs: DEFAULT_TIMEOUT_MS,
              },
              this.profile,
              FLOW_STEP.LINT_FIX,
              this.projectRoot,
            ),
            this.logger,
          );
        },
        rescanFiles: params.rescanFiles,
      });
    }
    // テストレビュー時は実装が未生成のためテスト実行をスキップ
    if (params.reviewMode !== "test" && params.runTests) {
      await params.runTests();
    }
  }

  private parseReviewResult(reviewer: string, output: string): ReviewResult {
    try {
      // コードフェンス（```json ... ```）を除去
      const cleaned = output.replace(/```(?:json)?\s*\n([\s\S]*?)```/g, "$1");

      // JSON.parse を直接試行し、失敗したら正規表現で抽出（非 greedy）
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(cleaned) as Record<string, unknown>;
      } catch {
        // 非 greedy: "issues" を含む最初の {...} を抽出
        const jsonMatch = /\{[^{}]*"issues"\s*:\s*\[[\s\S]*?\]\s*\}/.exec(cleaned);
        if (!jsonMatch) {
          throw new HarnessError(`レビュー出力からJSONを抽出できませんでした (reviewer: ${reviewer})`);
        }
        parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      }

      // schema validation: checklist / issues が配列であることを確認
      if (!Array.isArray(parsed.checklist)) {
        throw new HarnessError(`checklist フィールドが配列ではありません (reviewer: ${reviewer})`);
      }
      if (!Array.isArray(parsed.issues)) {
        throw new HarnessError(`issues フィールドが配列ではありません (reviewer: ${reviewer})`);
      }

      const validatedChecklist: ReviewChecklistEntry[] = [];
      let invalidChecklistCount = 0;
      for (const item of parsed.checklist) {
        if (
          typeof item === "object" && item !== null &&
          typeof (item as Record<string, unknown>).item === "string" &&
          typeof (item as Record<string, unknown>).verdict === "string" &&
          typeof (item as Record<string, unknown>).evidence === "string"
        ) {
          const checklistItem = item as Record<string, unknown>;
          const verdict = checklistItem.verdict as string;
          if (!["pass", "fail", "n/a"].includes(verdict)) {
            invalidChecklistCount++;
            continue;
          }
          validatedChecklist.push({
            item: checklistItem.item as string,
            verdict: verdict as "pass" | "fail" | "n/a",
            evidence: checklistItem.evidence as string,
          });
        } else {
          invalidChecklistCount++;
        }
      }

      if (validatedChecklist.length === 0) {
        throw new HarnessError(`checklist が空です (reviewer: ${reviewer})`);
      }

      // 各 issue の最低限の形状を検証
      const validatedIssues: ReviewIssue[] = [];
      let invalidCount = 0;
      for (const item of parsed.issues) {
        if (
          typeof item === "object" && item !== null &&
          typeof (item as Record<string, unknown>).description === "string" &&
          typeof (item as Record<string, unknown>).severity === "string" &&
          typeof (item as Record<string, unknown>).file === "string"
        ) {
          const i = item as Record<string, unknown>;
          validatedIssues.push({
            description: i.description as string,
            severity: (["critical", "major", "minor"].includes(i.severity as string)
              ? i.severity : "major") as "critical" | "major" | "minor",
            file: i.file as string,
            line: typeof i.line === "number" ? i.line : undefined,
          });
        } else {
          invalidCount++;
        }
      }

      // 不正要素がある場合: fail-closed
      if (invalidChecklistCount > 0 || invalidCount > 0) {
        throw new HarnessError(
          `レビュー出力に不正要素が含まれています (reviewer: ${reviewer})。checklist不正: ${invalidChecklistCount} 件, issue不正: ${invalidCount} 件`,
        );
      }

      return {
        reviewer,
        checklist: validatedChecklist,
        issues: validatedIssues,
        isLgtm: validatedIssues.length === 0,
      };
    } catch {
      // fail-closed: パース失敗時は LGTM にしない
      return {
        reviewer,
        checklist: [],
        issues: [
          {
            description: `レビュー結果のパースに失敗しました。出力を手動確認してください。`,
            severity: "critical",
            file: "",
          },
        ],
        isLgtm: false,
      };
    }
  }

  private async generateJudgmentSummary(
    issues: ReviewIssue[],
    diffBefore: string,
    diffAfter: string,
  ): Promise<string> {
    const issueText = issues
      .map((i) => `[${i.severity}] ${i.file}:${i.line ?? "?"} - ${i.description}`)
      .join("\n");

    try {
      const prompt = `以下のレビュー指摘に対してコード修正が行われました。なぜこの修正が必要だったのか、どういう判断で対応したかを3行以内で日本語で説明してください。

## レビュー指摘
${issueText}

## 修正前のdiff
${diffBefore.slice(0, 2000)}

## 修正後のdiff
${diffAfter.slice(0, 2000)}`;

      return this.executeRun(FLOW_STEP.JUDGMENT_SUMMARY, prompt, { allowedTools: ["Read"] });
    } catch {
      return "（判断理由の生成に失敗しました）";
    }
  }

  private async judgeMinorAcceptance(
    issues: ReviewIssue[],
    diffHistory: string,
    specPath: string,
  ): Promise<{ safe: boolean; reason: string }> {
    const issueText = issues
      .map((i) => `[${i.severity}] ${i.file}:${i.line ?? "?"} - ${i.description}`)
      .join("\n");
    const spec = readFileSync(specPath, "utf-8");

    try {
      const prompt = `あなたは第三者のコードレビュアーです。
以下の minor 指摘について、2回の修正試行後も解消されていません。
この指摘を許容（対応しない）して安全かどうか判断してください。

## 未解消の指摘
${issueText}

## 修正試行の履歴（diff）
${diffHistory.slice(0, 3000)}

## 仕様書
${spec.slice(0, 3000)}

## 判断基準
- 機能の正確性に影響するか
- 保守性に深刻な影響を与えるか
- 仕様書の要件を満たしているか

## 回答形式（厳守）
{"safe": true, "reason": "判断理由"}
または
{"safe": false, "reason": "判断理由"}`;

      const rawResult = await this.executeRun(FLOW_STEP.JUDGE_MINOR, prompt, {
        allowedTools: ["Read"],
        outputSchema: MINOR_ACCEPTANCE_SCHEMA,
      });
      const cleaned = rawResult.replace(/```(?:json)?\s*\n([\s\S]*?)```/g, "$1");
      const parsed = JSON.parse(cleaned) as { safe?: boolean; reason?: string };
      return {
        safe: parsed.safe ?? true,
        reason: parsed.reason ?? "（判断理由なし）",
      };
    } catch {
      // フォールバック: 判断失敗時は safe=true（ハーネスを止めない）
      return { safe: true, reason: "（第三者判断の生成に失敗。許容として扱う）" };
    }
  }

  private readFiles(files: string[]): string {
    return files
      .map((f) => {
        const content = readFileSync(f, "utf-8");
        return `### ${f}\n\`\`\`\n${content}\n\`\`\``;
      })
      .join("\n\n");
  }

  private async executeReview(
    step: FlowStep,
    prompt: string,
    reviewer: string,
    options?: {
      allowedTools?: string[];
      appendSystemPrompt?: string;
      timeoutMs?: number;
      outputSchema?: Record<string, unknown>;
    },
  ): Promise<ReviewResult> {
    const runner = this.registry.getRunner(step);
    const response = await runner.run(
      applyStepContext(
        {
          prompt,
          allowedTools: options?.allowedTools ?? ["Read"],
          timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          appendSystemPrompt: options?.appendSystemPrompt,
          outputSchema: options?.outputSchema,
        },
        this.profile,
        step,
        this.projectRoot,
      ),
      this.logger,
    );
    return this.parseReviewResult(reviewer, response.text);
  }

  private async executeRun(
    step: FlowStep,
    prompt: string,
    options?: {
      allowedTools?: string[];
      appendSystemPrompt?: string;
      cwd?: string;
      timeoutMs?: number;
      outputSchema?: Record<string, unknown>;
    },
  ): Promise<string> {
    const runner = this.registry.getRunner(step);
    const response = await runner.run(
      applyStepContext(
        {
          prompt,
          allowedTools: options?.allowedTools,
          appendSystemPrompt: options?.appendSystemPrompt,
          cwd: options?.cwd,
          timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          outputSchema: options?.outputSchema,
        },
        this.profile,
        step,
        this.projectRoot,
      ),
      this.logger,
    );
    return response.text;
  }
}
