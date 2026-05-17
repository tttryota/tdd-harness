import { createHash } from "node:crypto";
import { DriftError, ESCALATION_LEVEL, EVENT } from "../../domain/model/types.ts";
import type { EscalationLevel } from "../../domain/model/types.ts";
import type { Logger } from "../ports/logger.ts";

const MAX_TEST_RETRIES = 3;
const MAX_SAME_ERROR_COUNT = 3;
const TASK_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_FILE_ROLLBACKS = 2;
const SCOPE_DIFF_MULTIPLIER = 3;

type DriftState = {
  taskName: string;
  startTime: number;
  expectedScopeLines: number;
  testRetryCounts: Map<string, number>;
  errorHashes: string[];
  fileRollbackCounts: Map<string, number>;
  currentEscalation: EscalationLevel;
};

export class DriftGuard {
  private logger: Logger;
  private codexAvailable: boolean;
  private state: DriftState;

  constructor(
    logger: Logger,
    options?: { codexAvailable?: boolean },
  ) {
    this.logger = logger;
    this.codexAvailable = options?.codexAvailable ?? false;
    this.state = this.createInitialState();
  }

  startTask(taskName: string, expectedScopeLines: number): void {
    this.state = this.createInitialState();
    this.state.taskName = taskName;
    this.state.startTime = performance.now();
    this.state.expectedScopeLines = expectedScopeLines;
  }

  recordTestAttempt(
    testName: string,
    passed: boolean,
    errorMessage?: string,
  ): EscalationLevel | null {
    if (passed) {
      this.state.testRetryCounts.delete(testName);
      return null;
    }

    const current = this.state.testRetryCounts.get(testName) ?? 0;
    const newCount = current + 1;
    this.state.testRetryCounts.set(testName, newCount);

    if (errorMessage) {
      const hash = createHash("md5").update(errorMessage).digest("hex");
      this.state.errorHashes.push(hash);
    }

    if (newCount >= MAX_TEST_RETRIES) {
      return this.handleDrift("test_retry", newCount);
    }

    if (this.hasSameErrorRepeated()) {
      return this.handleDrift("same_error", MAX_SAME_ERROR_COUNT);
    }

    return null;
  }

  recordFileRollback(filePath: string): void {
    const current = this.state.fileRollbackCounts.get(filePath) ?? 0;
    const newCount = current + 1;
    this.state.fileRollbackCounts.set(filePath, newCount);

    if (newCount >= MAX_FILE_ROLLBACKS) {
      this.handleDrift("file_rollback", newCount);
    }
  }

  checkDiffScope(diffLines: number): void {
    const limit = this.state.expectedScopeLines * SCOPE_DIFF_MULTIPLIER;
    if (diffLines > limit) {
      this.handleDrift("diff_scope", diffLines);
    }
  }

  checkTimeout(): void {
    const elapsed = performance.now() - this.state.startTime;
    if (elapsed > TASK_TIMEOUT_MS) {
      this.handleDrift("timeout", Math.floor(elapsed / 1000));
    }
  }

  /**
   * 迷走検知時のエスカレーション処理（同期）。
   * Level 1/2 はログ記録+レベルを返す。
   * Level 3 は DriftError を throw する。
   */
  handleDrift(metric: string, value: number): EscalationLevel {
    this.logger.log(EVENT.DRIFT_DETECTED, { metric, value });

    // Level 1: 別アプローチ指示
    if (this.state.currentEscalation < ESCALATION_LEVEL.LEVEL_2) {
      this.state.currentEscalation = ESCALATION_LEVEL.LEVEL_2;
      return ESCALATION_LEVEL.LEVEL_1;
    }

    // Level 2: Codex 相談（利用可能な場合）
    if (
      this.state.currentEscalation < ESCALATION_LEVEL.LEVEL_3 &&
      this.codexAvailable
    ) {
      this.state.currentEscalation = ESCALATION_LEVEL.LEVEL_3;
      return ESCALATION_LEVEL.LEVEL_2;
    }

    // Level 3: 人間にエスカレーション
    this.logger.log(EVENT.ESCALATION_TO_HUMAN, {
      metric,
      value,
      taskName: this.state.taskName,
    });
    throw new DriftError(
      ESCALATION_LEVEL.LEVEL_3,
      metric,
      `迷走検知: ${metric}=${value}。人間のエスカレーションが必要です。`,
    );
  }

  reset(): void {
    this.state = this.createInitialState();
  }

  private hasSameErrorRepeated(): boolean {
    const hashes = this.state.errorHashes;
    if (hashes.length < MAX_SAME_ERROR_COUNT) return false;

    const recent = hashes.slice(-MAX_SAME_ERROR_COUNT);
    return recent.every((h) => h === recent[0]);
  }

  private createInitialState(): DriftState {
    return {
      taskName: "",
      startTime: performance.now(),
      expectedScopeLines: 0,
      testRetryCounts: new Map(),
      errorHashes: [],
      fileRollbackCounts: new Map(),
      currentEscalation: ESCALATION_LEVEL.LEVEL_1,
    };
  }
}
