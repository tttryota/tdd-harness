export const RETRY_POLICY = {
  pageBrowser: { maxAttempts: 2 },
  componentFix: { maxAttempts: 2 },
  implGreen: { maxAttempts: 3 },
  review: {
    maxCycles: 5,
    minorOnlyAcceptanceThreshold: 2,
  },
} as const;

export type RetryBudget = {
  maxAttempts: number;
};

export function isRetryExhausted(attempt: number, budget: RetryBudget): boolean {
  return attempt >= budget.maxAttempts;
}

export function hasRetryRemaining(attempt: number, budget: RetryBudget): boolean {
  return attempt < budget.maxAttempts;
}
