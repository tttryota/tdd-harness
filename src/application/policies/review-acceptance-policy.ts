import type { ReviewIssue } from "../../domain/model/types.ts";
import { RETRY_POLICY } from "./retry-policy.ts";
import { hasCriticalOrMajorIssues } from "./review-issue-policy.ts";

export function nextMinorOnlyCycles(currentCycles: number, issues: ReviewIssue[]): number {
  if (issues.length === 0) {
    return 0;
  }
  return hasCriticalOrMajorIssues(issues) ? 0 : currentCycles + 1;
}

export function shouldJudgeMinorAcceptance(minorOnlyCycles: number): boolean {
  return minorOnlyCycles >= RETRY_POLICY.review.minorOnlyAcceptanceThreshold;
}

export function shouldAcceptMinorVerdict(
  minorOnlyCycles: number,
  verdict: { safe: boolean },
): boolean {
  return shouldJudgeMinorAcceptance(minorOnlyCycles) && verdict.safe;
}
