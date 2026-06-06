import { resolve } from "node:path";
import { DriftError, HarnessError, ESCALATION_LEVEL, EVENT } from "../../domain/model/types.ts";
import type { LintViolation } from "../../domain/model/types.ts";
import type { LintAdapter, LintAdapterContext } from "../../infrastructure/tooling/tool-adapter.ts";
import type { LauncherOptions } from "../../infrastructure/process/launcher.ts";
import type { Logger } from "../ports/logger.ts";
import type { ToolExecutor } from "../ports/tool-executor.ts";

const MAX_LINT_RETRIES = 5;

export class LintGuard {
  private logger: Logger;
  private adapters: LintAdapter[];
  private launcherOptions: LauncherOptions;
  private toolExecutor: ToolExecutor;

  constructor(
    logger: Logger,
    adapters: LintAdapter[],
    launcherOptions: LauncherOptions,
    toolExecutor: ToolExecutor,
  ) {
    this.logger = logger;
    this.adapters = adapters;
    this.launcherOptions = launcherOptions;
    this.toolExecutor = toolExecutor;
  }

  async check(
    targetFiles: string[],
    options?: {
      claudeFix?: (violations: LintViolation[]) => Promise<void>;
      rescanFiles?: () => Promise<string[]>;
    },
  ): Promise<void> {
    let currentFiles = targetFiles;
    for (let attempt = 1; attempt <= MAX_LINT_RETRIES; attempt++) {
      // apply_fixes や lint_fix 後に対象ファイルが増減するため、毎回 scope を再解決する。
      if (attempt > 1 && options?.rescanFiles) {
        currentFiles = await options.rescanFiles();
      }
      const allViolations: LintViolation[] = [];

      for (const adapter of this.adapters) {
        const isProjectMode = adapter.filePass === "project";

        // adapter の fileExtensions でまず絞り込み、その上で fileFilter を適用
        const extSet = new Set(adapter.fileExtensions.map((ext) => `.${ext}`));
        let filteredFiles = currentFiles.filter((f) => {
          const dot = f.lastIndexOf(".");
          return dot !== -1 && extSet.has(f.slice(dot).toLowerCase());
        });
        if (adapter.fileFilter) {
          filteredFiles = filteredFiles.filter(adapter.fileFilter);
        }
        // files モードでは対象ファイルがなければスキップ
        // project モードでは scope 内ファイルの有無に関わらず実行（フィルタ用に保持）
        if (!isProjectMode && filteredFiles.length === 0) continue;

        const ctx: LintAdapterContext = {
          configArgs:
            adapter.resolveConfigArgs?.(this.launcherOptions.toolRoot) ?? [],
        };

        if (isProjectMode) {
          // project モード: ファイル引数なしで check のみ実行
          const checkArgs = adapter.checkArgs([], ctx);
          const checkResult = await this.toolExecutor.run(
            adapter.name,
            checkArgs,
            this.launcherOptions,
          );
          this.logger.logCommand(adapter.name, checkArgs, checkResult);

          const parsed = adapter.parseOutput(
            checkResult.stdout,
            checkResult.stderr,
            checkResult.exitCode,
          );

          if (parsed.kind === "tool-error") {
            throw new HarnessError(
              `${adapter.name} が設定エラーまたは内部エラーで終了しました: ${parsed.message}`,
            );
          }
          if (parsed.kind === "violations") {
            // scope 内ファイルのみにフィルタ
            // ツール出力のパスは toolRoot (cwd) 相対の場合があるため toolRoot 基準で resolve
            const toolCwd = resolve(this.launcherOptions.toolRoot);
            const scopeSet = new Set(filteredFiles.map((f) => resolve(f)));
            const scopedViolations = parsed.violations.filter(
              (v) => scopeSet.has(resolve(toolCwd, v.file)),
            );
            allViolations.push(...scopedViolations);
          }
        } else {
          // files モード
          // format
          if (adapter.formatArgs) {
            const formatResult = await this.toolExecutor.run(
              adapter.name,
              adapter.formatArgs(filteredFiles, ctx),
              this.launcherOptions,
            );
            if (formatResult.exitCode !== 0) {
              throw new HarnessError(
                `${adapter.name} format が失敗しました。設定を確認してください。\n${formatResult.stderr}`,
              );
            }
          }

          // auto-fix
          if (adapter.fixArgs) {
            await this.toolExecutor.run(
              adapter.name,
              adapter.fixArgs(filteredFiles, ctx),
              this.launcherOptions,
            );
          }

          // check
          const checkArgs = adapter.checkArgs(filteredFiles, ctx);
          const checkResult = await this.toolExecutor.run(
            adapter.name,
            checkArgs,
            this.launcherOptions,
          );
          this.logger.logCommand(adapter.name, checkArgs, checkResult);

          const parsed = adapter.parseOutput(
            checkResult.stdout,
            checkResult.stderr,
            checkResult.exitCode,
          );

          if (parsed.kind === "tool-error") {
            throw new HarnessError(
              `${adapter.name} が設定エラーまたは内部エラーで終了しました: ${parsed.message}`,
            );
          }
          if (parsed.kind === "violations") {
            allViolations.push(...parsed.violations);
          }
        }
      }

      if (allViolations.length === 0) {
        this.logger.log(EVENT.LINT_PASSED, { attempt });
        return;
      }

      this.logger.log(EVENT.LINT_VIOLATIONS, {
        attempt,
        count: allViolations.length,
        violations: allViolations,
      });

      if (attempt < MAX_LINT_RETRIES && options?.claudeFix) {
        await options.claudeFix(allViolations);
      }
    }

    throw new DriftError(
      ESCALATION_LEVEL.LEVEL_1,
      "lint_retry",
      `リンター違反が ${MAX_LINT_RETRIES} 回の修正後も残っています`,
    );
  }
}
