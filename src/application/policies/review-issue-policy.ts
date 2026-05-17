import { resolve } from "node:path";
import type { BrowserVerificationResult, ReviewIssue, ReviewResult } from "../../domain/model/types.ts";

export type ScopedFiles = {
  files: string[];
};

export type AcceptedReviewIssue = {
  issue: ReviewIssue;
  reviewer: string;
  judgmentSummary: string;
};

export function toScopedFiles(files: string[]): ScopedFiles {
  return { files: [...files] };
}

export function filterIssuesToScope(issues: ReviewIssue[], scopedFiles: ScopedFiles): ReviewIssue[] {
  const allowed = new Set(scopedFiles.files.map((file) => resolve(file)));
  return issues.filter((issue) => {
    if (!issue.file) return true;
    return allowed.has(resolve(issue.file));
  });
}

export function hasParseFailure(issues: ReviewIssue[]): boolean {
  return issues.some((issue) => issue.file === "" && issue.severity === "critical");
}

export function hasCriticalOrMajorIssues(issues: ReviewIssue[]): boolean {
  return issues.some((issue) => issue.severity === "critical" || issue.severity === "major");
}

export function reconcileReviewIssues(
  a: ReviewResult,
  b: ReviewResult,
): { toFix: ReviewIssue[]; accepted: AcceptedReviewIssue[] } {
  const toFix: ReviewIssue[] = [];
  const accepted: AcceptedReviewIssue[] = [];
  const allIssues = [
    ...a.issues.map((issue) => ({ issue, reviewer: a.reviewer, otherIssues: b.issues })),
    ...b.issues.map((issue) => ({ issue, reviewer: b.reviewer, otherIssues: a.issues })),
  ];

  for (const entry of allIssues) {
    if (entry.issue.severity === "critical" || entry.issue.severity === "major") {
      toFix.push(entry.issue);
      continue;
    }

    const confirmedByOther = entry.otherIssues.some(
      (other) => other.file === entry.issue.file && other.description === entry.issue.description,
    );
    if (confirmedByOther) {
      toFix.push(entry.issue);
      continue;
    }

    accepted.push({
      issue: entry.issue,
      reviewer: entry.reviewer,
      judgmentSummary: "片方のエージェントのみが指摘した minor 指摘のため対応不要と判断",
    });
  }

  return { toFix, accepted };
}

export function browserIssuesFromResult(result: BrowserVerificationResult): ReviewIssue[] {
  const issues = result.scenarios
    .filter((scenario) => scenario.status !== "pass")
    .map((scenario) => {
      const expected = scenario.expected?.join(" / ") ?? "期待結果不明";
      const observed = scenario.observed?.join(" / ") ?? "観測結果不明";
      const failureDetail = scenario.failedStep ? `失敗ステップ: ${scenario.failedStep}` : "失敗ステップ不明";
      return {
        description: `Browser Verification 失敗: ${scenario.name}. ${failureDetail}. expected=${expected}. observed=${observed}. ${scenario.notes ?? ""}`.trim(),
        severity: scenario.status === "blocked" ? "critical" : "major",
        file: "",
      } satisfies ReviewIssue;
    });

  if (issues.length === 0 && result.overall !== "pass") {
    issues.push({
      description: `Browser Verification 全体が ${result.overall} で終了しました。scenario 単位の詳細が返っていません。`,
      severity: "critical",
      file: "",
    });
  }

  return issues;
}
