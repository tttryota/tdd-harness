// === claude -p の JSON 出力 ===

export type ClaudeResult = {
  result: string;
  structured_output?: unknown;
  session_id: string;
  is_error: boolean;
  total_cost_usd: number | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

// === エスカレーション ===

export const ESCALATION_LEVEL = {
  LEVEL_1: 1,
  LEVEL_2: 2,
  LEVEL_3: 3,
} as const;

export type EscalationLevel =
  (typeof ESCALATION_LEVEL)[keyof typeof ESCALATION_LEVEL];

// === 例外 ===

export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessError";
  }
}

export class DriftError extends HarnessError {
  level: EscalationLevel;
  metric: string;

  constructor(level: EscalationLevel, metric: string, message: string) {
    super(message);
    this.name = "DriftError";
    this.level = level;
    this.metric = metric;
  }
}

export class GuardError extends HarnessError {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

export class RunnerRateLimitError extends HarnessError {
  runnerName: string;
  constructor(runnerName: string, message: string) {
    super(message);
    this.name = "RunnerRateLimitError";
    this.runnerName = runnerName;
  }
}

// === リント ===

export type LintViolation = {
  tool: string;
  file: string;
  line: number;
  message: string;
};

// === レビュー ===

export type ReviewIssue = {
  description: string;
  severity: "critical" | "major" | "minor";
  file: string;
  line?: number;
};

export type ReviewChecklistEntry = {
  item: string;
  verdict: "pass" | "fail" | "n/a";
  evidence: string;
};

export type ReviewResult = {
  reviewer: string;
  checklist: ReviewChecklistEntry[];
  issues: ReviewIssue[];
  isLgtm: boolean;
};

// === 計画ファイル ===

export type PlanType = "impl" | "component" | "page";

export type PlanDependency = {
  name: string;
  importPath: string;
};

export type BrowserScenario = {
  name: string;
  objective: string;
  route: string;
  preconditions: string[];
  steps: string[];
  expect: string[];
};

export type BrowserScenarioResult = {
  name: string;
  status: "pass" | "fail" | "blocked";
  completedSteps: string[];
  failedStep?: string;
  expected?: string[];
  observed?: string[];
  notes?: string;
};

export type BrowserVerificationResult = {
  overall: "pass" | "fail" | "blocked";
  scenarios: BrowserScenarioResult[];
};

export type TaskPlan = {
  type?: PlanType;
  profile?: string;
  scope: string;
  specPath: string;
  testCasesPath: string;
  componentSpecPath?: string;
  figmaCachePath?: string;
  msw?: boolean;
  description: string;
  targets: string[];
  dependencies: PlanDependency[];
  figmaSlice?: string;
  browserScenarios: BrowserScenario[];
  targetTestCases: string[];
  exclusions: string[];
  completionCriteria: string[];
  designDecisions: string[];
};

// === レビューレポート ===

export type ReviewRecord = {
  step: string;
  cycle: number;
  reviewer: string;
  findings: ReviewIssue[];
  decision: "fixed" | "accepted" | "escalated" | "lgtm";
  diffBefore: string;
  diffAfter: string;
};

export type ReviewDataStatus = "completed" | "failed";

export type RunnerUsageTotalsShape = {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type RunnerUsageSummaryShape = {
  total: RunnerUsageTotalsShape;
  byStep: Record<string, RunnerUsageTotalsShape>;
};

export type ReviewDataErrorMeta = {
  name: string;
  message: string;
  metric?: string;
  level?: EscalationLevel;
};

export type ImplReviewData = {
  plan: TaskPlan;
  records: ReviewRecord[];
  tdd: {
    greenAttempts: number;
    alreadyGreen: boolean;
  };
  usageSummary: RunnerUsageSummaryShape;
  status: ReviewDataStatus;
  error?: ReviewDataErrorMeta;
};

// === コマンド実行結果 ===

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

// === チェックポイント ===

export const STEP_ORDER = [
  "test_generated",
  "test_reviewed",
  "red_confirmed",
  "green_confirmed",
  "impl_review_criteria_passed",
  "impl_review_quality_passed",
  "impl_reviewed",
] as const;

export type CompletedStep = (typeof STEP_ORDER)[number];

export type CheckpointData = {
  planPath: string;
  completedStep: CompletedStep;
  sessionId: string;
  testGenerationDecision?: "noop" | "updated" | "contract_revision_required";
  records: ReviewRecord[];
  greenAttempt: number;
  timestamp: string;
  logDir?: string;
};

// === ログイベント定数 ===

export const EVENT = {
  GUARD_CHECK: "guard_check",
  TDD_START: "tdd_start",
  CLAUDE_P_CALL: "claude_p_call",
  TEST_RUN: "test_run",
  LINT_VIOLATIONS: "lint_violations",
  LINT_PASSED: "lint_passed",
  SELF_REVIEW: "self_review",
  REVIEW_START: "review_start",
  RUNNER_RATE_LIMITED: "runner_rate_limited",
  FALLBACK_REVIEW: "fallback_review",
  REVIEW_RECONCILED: "review_reconciled",
  REVIEW_RESULT: "review_result",
  DRIFT_DETECTED: "drift_detected",
  ESCALATION_TO_HUMAN: "escalation_to_human",
  RUNNER_USAGE: "runner_usage",
} as const;
