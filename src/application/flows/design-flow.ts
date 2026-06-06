import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../ports/logger.ts";
import type { ProjectBoundary } from "../ports/project-boundary.ts";
import type { RunnerRegistry } from "../../infrastructure/runners/runner-registry.ts";
import type { ResolvedProfileConfig } from "../../infrastructure/config/config.ts";
import { FLOW_STEP } from "../../domain/model/steps.ts";
import { DriftError, GuardError } from "../../domain/model/types.ts";
import { applyStepContext, joinPromptSections } from "../../infrastructure/runners/step-context.ts";
import { loadTemplate } from "../../infrastructure/templates/templates.ts";
import { isReadyLikeStatus } from "../policies/plan-readiness-policy.ts";
import { ReviewOrchestrator } from "../review/review-orchestrator.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SPEC_DIR_TEMPLATE = "docs/spec/{{category}}";
const DEFAULT_TEST_CASE_DIR_TEMPLATE = "tests/test-cases/{{category}}";
const DEFAULT_SOURCE_DIR_TEMPLATE = "backend/{{category}}";
const DEFAULT_SOURCE_TEST_DIR_TEMPLATE = "backend/{{category}}/tests";
const DEFAULT_SCOPE_PATTERN_TEMPLATE = "backend/{{category}}/*";

/**
 * `design` は backend 実装の前提となる spec / test_cases を整える。
 * plan 作成や実装着手は行わず、人間が `status: ready` を付けられるところまでで止まる。
 */
export class DesignFlow {
  private boundary: ProjectBoundary;
  private registry: RunnerRegistry;
  private profile?: ResolvedProfileConfig;

  constructor(boundary: ProjectBoundary, registry: RunnerRegistry, profile?: ResolvedProfileConfig) {
    this.boundary = boundary;
    this.registry = registry;
    this.profile = profile;
  }

  async run(featureName: string, requirements: string, logger: Logger): Promise<void> {
    const root = this.boundary.getProjectRoot();
    const category = this.boundary.extractCategory(featureName);
    const name = this.boundary.extractName(featureName);
    const specDir = this.resolveDesignDir(
      this.profile?.designLayout.specDir ?? DEFAULT_SPEC_DIR_TEMPLATE,
      category,
      name,
    );
    const testCaseDir = this.resolveDesignDir(
      this.profile?.designLayout.testCaseDir ?? DEFAULT_TEST_CASE_DIR_TEMPLATE,
      category,
      name,
    );
    const specPath = join(root, specDir, `${name}.md`);
    const tcPath = join(root, testCaseDir, `${name}.md`);
    const specReviewContext = this.buildSpecReviewContext(category, name);

    // design-flow の書き込み先を仕様書/テストケースディレクトリに限定
    const specAllowedTools = [
      "Read",
      `Write(${specDir}/*)`,
      `Edit(${specDir}/*)`,
    ];
    const tcAllowedTools = [
      "Read",
      `Write(${testCaseDir}/*)`,
      `Edit(${testCaseDir}/*)`,
    ];
    const reviewAllowedTools = [
      "Read",
      `Write(${specDir}/*)`,
      `Edit(${specDir}/*)`,
      `Write(${testCaseDir}/*)`,
      `Edit(${testCaseDir}/*)`,
    ];

    const specExisted = existsSync(specPath);
    const tcExisted = existsSync(tcPath);
    const specReadyAtStart = specExisted && isReadyLikeStatus(this.boundary.readFrontmatter(specPath).status);
    const tcReadyAtStart = tcExisted && isReadyLikeStatus(this.boundary.readFrontmatter(tcPath).status);

    if (specReadyAtStart && tcReadyAtStart) {
      console.log("仕様書・テストケースともに ready です。impl フローに進めます。");
      return;
    }

    if (specExisted) {
      console.log(`仕様書は既に存在します: ${specPath}`);
    } else {
      await this.generateSpec(featureName, specPath, requirements, specAllowedTools, logger);
      if (!existsSync(specPath)) {
        throw new GuardError(`仕様書が生成されませんでした: ${specPath}`);
      }
      console.log(`仕様書を生成しました: ${specPath}`);
    }

    // spec が draft でも test_cases 生成までは進める。
    // ここで止めると、spec と test_cases の整合レビューに必要な材料が揃わない。
    const specReadyAfterLoad = isReadyLikeStatus(this.boundary.readFrontmatter(specPath).status);
    if (!specReadyAfterLoad) {
      await this.runSpecReview(specPath, specAllowedTools, logger, specReviewContext, requirements);
    }

    if (existsSync(tcPath)) {
      console.log(`テストケースは既に存在します: ${tcPath}`);
    } else {
      await this.generateTestCases(featureName, specPath, tcPath, tcAllowedTools, logger);
      if (!existsSync(tcPath)) {
        throw new GuardError(`テストケースが生成されませんでした: ${tcPath}`);
      }
      console.log(`テストケースを生成しました: ${tcPath}`);
    }

    await this.runSpecTcReview(specPath, tcPath, reviewAllowedTools, logger, requirements);

    const specFm = this.boundary.readFrontmatter(specPath);
    const tcFm = this.boundary.readFrontmatter(tcPath);
    if (!isReadyLikeStatus(specFm.status) || !isReadyLikeStatus(tcFm.status)) {
      console.log("spec_tc_review が完了しました。人間が仕様書・テストケースを確認し、frontmatter の status を ready に更新してください。");
      return;
    }

    console.log("仕様書・テストケースともに ready です。impl フローに進めます。");
  }

  private async generateSpec(
    featureName: string, outputPath: string, requirements: string,
    allowedTools: string[], logger: Logger,
  ): Promise<void> {
    const root = this.boundary.getProjectRoot();
    const template = this.loadDesignTemplate("spec-template");
    const claudeMd = this.readClaudeMd();

    const runner = this.registry.getRunner(FLOW_STEP.SPEC_GENERATE);
      await runner.run(
      applyStepContext(
        {
          prompt: `以下の要件から機能仕様書を作成してください。

## 要件
${requirements}

## 出力先
${outputPath}

## feature名
${featureName}

## テンプレート
${template}

## 制約
- 必ず上記の出力先パスにファイルを作成すること
- 5〜15個のテストケースが書ける粒度にする
- 他の仕様書を読まなくても実装に着手できる独立性
- 依存は他コンポーネントのインターフェース参照のみ`,
          allowedTools,
          appendSystemPrompt: joinPromptSections([claudeMd]),
          cwd: root,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        },
        this.profile,
        FLOW_STEP.SPEC_GENERATE,
        root,
      ),
      logger,
    );
  }

  private async generateTestCases(
    featureName: string, specPath: string, outputPath: string,
    allowedTools: string[], logger: Logger,
  ): Promise<void> {
    const root = this.boundary.getProjectRoot();
    const spec = readFileSync(specPath, "utf-8");
    const template = this.loadDesignTemplate("test-case-template");

    const runner = this.registry.getRunner(FLOW_STEP.TEST_CASE_GENERATE);
    await runner.run(
      applyStepContext(
        {
          prompt: `以下の仕様書からテストケースを導出してください。

## 仕様書
${spec}

## 出力先
${outputPath}

## feature名
${featureName}

## テンプレート
${template}

## 制約
- 必ず上記の出力先パスにファイルを作成すること
- 正常系・境界系・異常系を網羅
- Phase分け（最小骨格 → コアロジック → エッジケース → 外部連携）
- 実装順序を考慮した並び
- テストの種類ごとに検証焦点を明示すること
- 仕様書の受け入れ基準の各項目に対応するテストケースが最低1つ存在すること
- 対応関係を網羅性チェックセクションに記載すること
- 重複がないこと`,
          allowedTools,
          appendSystemPrompt: joinPromptSections([this.readClaudeMd()]),
          cwd: root,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        },
        this.profile,
        FLOW_STEP.TEST_CASE_GENERATE,
        root,
      ),
      logger,
    );
  }

  private readClaudeMd(): string {
    const claudeMdPath = join(this.boundary.getProjectRoot(), "CLAUDE.md");
    return existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf-8") : "";
  }

  private buildSpecReviewContext(category: string, name: string): string {
    const sourceDir = this.resolveDesignDir(
      this.profile?.sourceLayout?.sourceDir ?? DEFAULT_SOURCE_DIR_TEMPLATE,
      category,
      name,
    );
    const testDir = this.resolveDesignDir(
      this.profile?.sourceLayout?.testDir ?? DEFAULT_SOURCE_TEST_DIR_TEMPLATE,
      category,
      name,
    );
    const scopePattern = this.resolveDesignDir(
      this.profile?.sourceLayout?.scopePattern ?? DEFAULT_SCOPE_PATTERN_TEMPLATE,
      category,
      name,
    );
    return [
      `- sourceDir: ${sourceDir}`,
      `- testDir: ${testDir}`,
      `- scopePattern: ${scopePattern}`,
    ].join("\n");
  }

  private resolveDesignDir(template: string, category: string, name: string): string {
    return template.replaceAll("{{category}}", category).replaceAll("{{name}}", name);
  }

  private loadDesignTemplate(templateName: string): string {
    return loadTemplate(
      templateName,
      this.boundary.getProjectRoot(),
      this.registry.getConfig().templates,
    );
  }

  private createDesignReviewOrchestrator(logger: Logger): ReviewOrchestrator {
    const lintGuard = { async check() {} } as any;
    return new ReviewOrchestrator(
      logger,
      lintGuard,
      this.boundary.getProjectRoot(),
      this.registry,
      this.profile,
    );
  }

  private wrapDesignReviewError(reviewStep: "spec_review" | "spec_tc_review", error: unknown): never {
    if (error instanceof DriftError) {
      throw new DriftError(
        error.level,
        error.metric,
        `${reviewStep} が失敗しました: ${error.message}`,
      );
    }
    throw error;
  }

  private async runSpecTcReview(
    specPath: string,
    testCasesPath: string,
    scopeAllowedTools: string[],
    logger: Logger,
    designRequirements: string,
  ): Promise<void> {
    const orchestrator = this.createDesignReviewOrchestrator(logger);

    try {
      await orchestrator.runSpecTcReview({
        targetFiles: [specPath, testCasesPath],
        specPath,
        testCasesPath,
        criteriaPaths: [],
        scopeAllowedTools,
        reviewMode: "design",
        designRequirements,
      });
    } catch (error: unknown) {
      this.wrapDesignReviewError("spec_tc_review", error);
    }
  }

  private async runSpecReview(
    specPath: string,
    scopeAllowedTools: string[],
    logger: Logger,
    designContextText: string,
    designRequirements: string,
  ): Promise<void> {
    const orchestrator = this.createDesignReviewOrchestrator(logger);

    try {
      await orchestrator.runSpecReview({
        targetFiles: [specPath],
        specPath,
        criteriaPaths: [],
        scopeAllowedTools,
        reviewMode: "design",
        designContextText,
        designRequirements,
      });
    } catch (error: unknown) {
      this.wrapDesignReviewError("spec_review", error);
    }
  }
}
