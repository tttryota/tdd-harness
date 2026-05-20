import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig, resolveProfile } from "../../infrastructure/config/config.ts";
import { findSkillFilePath, resolveStepContext } from "../../infrastructure/runners/step-context.ts";
import { loadTemplate } from "../../infrastructure/templates/templates.ts";
import { summarizeRunnerUsageFromLog } from "../../infrastructure/logging/logger.ts";
import { GuardError } from "../../domain/model/types.ts";
import { FLOW_STEP } from "../../domain/model/steps.ts";
import type { FlowStep } from "../../domain/model/steps.ts";
import type { ReviewRecord } from "../../domain/model/types.ts";

type HarnessEvent = {
  ts: string;
  event: string;
  step?: string;
  runner?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  costUsd?: number | null;
};

type RunnerUsageEvent = {
  ts: string;
  step: string;
  runner: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
  wallClockSeconds: number;
  commandDurationMs?: number;
  outputChars?: number;
  modelNames: string[];
};

type ReviewRecordShape = ReviewRecord;

type ReviewDataShape = {
  plan?: {
    profile?: string;
    scope?: string;
  };
  records?: ReviewRecordShape[];
  tdd?: {
    greenAttempts?: number;
    alreadyGreen?: boolean;
  };
};

type SeverityCounts = {
  critical: number;
  major: number;
  minor: number;
};

type StepDiagnosis = {
  step: string;
  runners: string[];
  runs: number;
  wallClockSeconds: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
  reviewCycles: number;
  findings: number;
  severityCounts: SeverityCounts;
  commandDurationMs: number;
  outputChars: number;
  staticPromptChars?: number;
  templateChars?: number;
  skillPromptChars?: number;
};

type Opportunity = {
  category: "time" | "cost" | "prompt" | "review";
  step: string;
  message: string;
};

type BenchmarkDiagnosis = {
  label: string;
  scope: string;
  profileName?: string;
  totalWallClockSeconds: number;
  totalLlmRuns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
  reviewCycles: number;
  fixedFindings: number;
  acceptedFindings: number;
  alreadyGreen: boolean;
  greenAttempts: number;
  steps: StepDiagnosis[];
  opportunities: Opportunity[];
};

type LlmCommandDetail = {
  durationMs: number;
  outputChars: number;
  modelNames: string[];
};

const SUMMARY_STEP_ORDER: string[] = [
  FLOW_STEP.TEST_GENERATE,
  FLOW_STEP.SPEC_TC_REVIEW,
  FLOW_STEP.TEST_SELF_QUALITY,
  FLOW_STEP.TEST_EXTERNAL_REVIEW,
  FLOW_STEP.IMPL_GENERATE,
  FLOW_STEP.IMPL_SELF_CRITERIA,
  FLOW_STEP.IMPL_SELF_QUALITY,
  FLOW_STEP.IMPL_EXTERNAL_REVIEW,
  FLOW_STEP.LINT_FIX,
  FLOW_STEP.APPLY_FIXES,
  FLOW_STEP.JUDGE_MINOR,
];

const REVIEW_STEP_MAP: Record<string, string> = {
  spec_tc_review: FLOW_STEP.SPEC_TC_REVIEW,
  test_self_quality: FLOW_STEP.TEST_SELF_QUALITY,
  test_external: FLOW_STEP.TEST_EXTERNAL_REVIEW,
  self_criteria: FLOW_STEP.IMPL_SELF_CRITERIA,
  self_quality: FLOW_STEP.IMPL_SELF_QUALITY,
  impl_external: FLOW_STEP.IMPL_EXTERNAL_REVIEW,
};

const TEMPLATE_MAP: Partial<Record<FlowStep, string[]>> = {
  [FLOW_STEP.TEST_GENERATE]: ["test-generate"],
  [FLOW_STEP.SPEC_TC_REVIEW]: ["review-spec-tc-consistency", "review-response-format"],
  [FLOW_STEP.IMPL_GENERATE]: ["impl-generate", "impl-retry"],
  [FLOW_STEP.TEST_SELF_QUALITY]: ["review-test-quality", "review-response-format"],
  [FLOW_STEP.TEST_EXTERNAL_REVIEW]: ["review-external-test", "review-response-format"],
  [FLOW_STEP.IMPL_SELF_CRITERIA]: ["review-impl-criteria", "review-response-format"],
  [FLOW_STEP.IMPL_SELF_QUALITY]: ["review-impl-quality", "review-response-format"],
  [FLOW_STEP.IMPL_EXTERNAL_REVIEW]: ["review-external-impl", "review-response-format"],
};

export function renderBenchmarkDiagnose(logDirs: string[], projectRoot: string): string {
  if (logDirs.length === 0 || logDirs.length > 2) {
    throw new GuardError("benchmark-diagnose には 1 つまたは 2 つの log directory を指定してください。");
  }

  const diagnoses = logDirs.map((logDir) => loadDiagnosis(logDir, projectRoot));
  if (diagnoses.length === 1) {
    return renderSingleDiagnosis(diagnoses[0]);
  }
  return renderDiagnosisDiff(diagnoses[0], diagnoses[1]);
}

function loadDiagnosis(logDir: string, projectRoot: string): BenchmarkDiagnosis {
  const harnessEvents = readHarnessEvents(join(logDir, "harness.jsonl"));
  const runnerUsageEvents = parseRunnerUsageEvents(harnessEvents);
  const reviewData = readOptionalReviewData(join(logDir, "review-data.json"));
  pairClaudeCommandDetails(runnerUsageEvents, join(logDir, "claude-code.log"));
  pairCodexTranscriptDetails(runnerUsageEvents, join(logDir, "codex-app-server.log"));

  const stepDiagnoses = summarizeSteps(runnerUsageEvents, reviewData, projectRoot);
  const totalWallClockSeconds = harnessEvents.length >= 2
    ? secondsBetween(harnessEvents[0].ts, harnessEvents[harnessEvents.length - 1].ts)
    : 0;
  const fixedFindings = (reviewData?.records ?? [])
    .filter((record) => record.decision === "fixed")
    .reduce((sum, record) => sum + record.findings.length, 0);
  const acceptedFindings = (reviewData?.records ?? [])
    .filter((record) => record.decision === "accepted")
    .length;
  const usageSummary = summarizeRunnerUsageFromLog(join(logDir, "harness.jsonl"));
  const totalCacheRead = runnerUsageEvents.reduce((sum, event) => sum + event.cacheReadInputTokens, 0);
  const totalCacheCreation = runnerUsageEvents.reduce((sum, event) => sum + event.cacheCreationInputTokens, 0);

  const diagnosis: BenchmarkDiagnosis = {
    label: logDir,
    scope: reviewData?.plan?.scope ?? basename(logDir),
    profileName: reviewData?.plan?.profile,
    totalWallClockSeconds,
    totalLlmRuns: usageSummary.total.runs,
    inputTokens: usageSummary.total.inputTokens,
    outputTokens: usageSummary.total.outputTokens,
    cacheReadInputTokens: totalCacheRead,
    cacheCreationInputTokens: totalCacheCreation,
    costUsd: usageSummary.total.costUsd,
    reviewCycles: countActiveReviewCycles(reviewData?.records ?? []),
    fixedFindings,
    acceptedFindings,
    alreadyGreen: reviewData?.tdd?.alreadyGreen ?? false,
    greenAttempts: reviewData?.tdd?.greenAttempts ?? 0,
    steps: sortSteps(stepDiagnoses),
    opportunities: [],
  };
  diagnosis.opportunities = deriveOpportunities(diagnosis);
  return diagnosis;
}

function renderSingleDiagnosis(diagnosis: BenchmarkDiagnosis): string {
  const lines = [
    `Benchmark diagnose: ${diagnosis.label}`,
    "",
    "## Summary",
    `- Scope: ${diagnosis.scope}`,
    `- Profile: ${diagnosis.profileName ?? "unknown"}`,
    `- Wall clock: ${formatDuration(diagnosis.totalWallClockSeconds)}`,
    `- LLM runs: ${diagnosis.totalLlmRuns}`,
    `- Review cycles: ${diagnosis.reviewCycles}`,
    `- Fixed findings: ${diagnosis.fixedFindings}`,
    `- Accepted findings: ${diagnosis.acceptedFindings}`,
    `- Green attempts: ${diagnosis.alreadyGreen ? "already green" : diagnosis.greenAttempts}`,
    `- Input tokens: ${diagnosis.inputTokens}`,
    `- Output tokens: ${diagnosis.outputTokens}`,
    `- Cost USD: ${diagnosis.costUsd.toFixed(4)}`,
    "",
    "## Step Breakdown",
    "| Step | Runner | Runs | Wall | Input | Output | Cache Read | Cost USD | Review cycles | Findings | Prompt baggage |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...diagnosis.steps.map((step) =>
      `| ${step.step} | ${step.runners.join(",")} | ${step.runs} | ${formatDuration(step.wallClockSeconds)} | ${step.inputTokens} | ${step.outputTokens} | ${step.cacheReadInputTokens} | ${step.costUsd.toFixed(4)} | ${step.reviewCycles} | ${step.findings} | ${formatChars(step.staticPromptChars)} |`,
    ),
    "",
    "## Findings",
    ...renderFindings(diagnosis),
    "",
    "## Optimization Opportunities",
    ...renderOpportunities(diagnosis.opportunities),
  ];
  return lines.join("\n");
}

function renderDiagnosisDiff(before: BenchmarkDiagnosis, after: BenchmarkDiagnosis): string {
  const lines = [
    "Benchmark diagnose diff",
    `- Before: ${before.label}`,
    `- After: ${after.label}`,
    "",
    "## Summary Diff",
    "| Metric | Before | After | Delta |",
    "|---|---:|---:|---:|",
    `| Wall clock | ${formatDuration(before.totalWallClockSeconds)} | ${formatDuration(after.totalWallClockSeconds)} | ${formatSignedDuration(after.totalWallClockSeconds - before.totalWallClockSeconds)} |`,
    `| LLM runs | ${before.totalLlmRuns} | ${after.totalLlmRuns} | ${formatSigned(after.totalLlmRuns - before.totalLlmRuns)} |`,
    `| Review cycles | ${before.reviewCycles} | ${after.reviewCycles} | ${formatSigned(after.reviewCycles - before.reviewCycles)} |`,
    `| Input tokens | ${before.inputTokens} | ${after.inputTokens} | ${formatSigned(after.inputTokens - before.inputTokens)} |`,
    `| Output tokens | ${before.outputTokens} | ${after.outputTokens} | ${formatSigned(after.outputTokens - before.outputTokens)} |`,
    `| Cost USD | ${before.costUsd.toFixed(4)} | ${after.costUsd.toFixed(4)} | ${formatSigned(after.costUsd - before.costUsd, 4)} |`,
    "",
    "## Step Diff",
    "| Step | Wall delta | Input delta | Cost delta | Findings delta |",
    "|---|---:|---:|---:|---:|",
    ...renderStepDiff(before.steps, after.steps),
    "",
    "## Improvement Notes",
    ...renderDiffFindings(before, after),
  ];
  return lines.join("\n");
}

function renderFindings(diagnosis: BenchmarkDiagnosis): string[] {
  const lines: string[] = [];
  const topByTime = [...diagnosis.steps].sort((a, b) => b.wallClockSeconds - a.wallClockSeconds).slice(0, 3);
  const topByCost = [...diagnosis.steps].sort((a, b) => b.costUsd - a.costUsd).slice(0, 3);

  lines.push(`- Total cache-read input was ${diagnosis.cacheReadInputTokens} tokens, suggesting repeated context reuse is material.`);
  lines.push(
    `- Longest steps by wall clock: ${topByTime.map((step) => `${step.step} (${formatDuration(step.wallClockSeconds)})`).join(", ")}.`,
  );
  lines.push(
    `- Highest-cost steps: ${topByCost.map((step) => `${step.step} (${step.costUsd.toFixed(4)} USD)`).join(", ")}.`,
  );

  for (const step of diagnosis.steps) {
    if (step.reviewCycles > 0 && step.findings === 0 && step.outputTokens >= 1000) {
      lines.push(
        `- ${step.step} produced ${step.outputTokens} output tokens across ${step.reviewCycles} review cycle(s) with 0 findings.`,
      );
    }
  }

  return lines;
}

function renderOpportunities(opportunities: Opportunity[]): string[] {
  if (opportunities.length === 0) {
    return ["- 明確な最適化候補は検出されませんでした。"];
  }
  return opportunities.map((opportunity) => `- [${opportunity.category}] ${opportunity.step}: ${opportunity.message}`);
}

function renderStepDiff(before: StepDiagnosis[], after: StepDiagnosis[]): string[] {
  const allSteps = uniqueStrings([...before.map((step) => step.step), ...after.map((step) => step.step)]);
  return allSteps.map((step) => {
    const beforeStep = before.find((item) => item.step === step);
    const afterStep = after.find((item) => item.step === step);
    return `| ${step} | ${formatSignedDuration((afterStep?.wallClockSeconds ?? 0) - (beforeStep?.wallClockSeconds ?? 0))} | ${formatSigned((afterStep?.inputTokens ?? 0) - (beforeStep?.inputTokens ?? 0))} | ${formatSigned((afterStep?.costUsd ?? 0) - (beforeStep?.costUsd ?? 0), 4)} | ${formatSigned((afterStep?.findings ?? 0) - (beforeStep?.findings ?? 0))} |`;
  });
}

function renderDiffFindings(before: BenchmarkDiagnosis, after: BenchmarkDiagnosis): string[] {
  const lines: string[] = [];
  const wallDelta = after.totalWallClockSeconds - before.totalWallClockSeconds;
  const costDelta = after.costUsd - before.costUsd;
  const cycleDelta = after.reviewCycles - before.reviewCycles;
  lines.push(
    `- Wall clock ${wallDelta <= 0 ? "improved" : "regressed"} by ${formatSignedDuration(wallDelta)} and cost ${costDelta <= 0 ? "improved" : "regressed"} by ${formatSigned(costDelta, 4)} USD.`,
  );
  lines.push(
    `- Review cycles ${cycleDelta <= 0 ? "did not increase" : "increased"} (${formatSigned(cycleDelta)}).`,
  );
  const beforeTop = topStepName(before.steps, "wallClockSeconds");
  const afterTop = topStepName(after.steps, "wallClockSeconds");
  if (beforeTop || afterTop) {
    lines.push(`- Dominant wall-clock step: before=${beforeTop ?? "n/a"}, after=${afterTop ?? "n/a"}.`);
  }
  return lines;
}

function summarizeSteps(
  usageEvents: RunnerUsageEvent[],
  reviewData: ReviewDataShape | null,
  projectRoot: string,
): StepDiagnosis[] {
  const byStep = new Map<string, StepDiagnosis>();
  const reviewStats = buildReviewStats(reviewData?.records ?? []);
  const promptSizes = computePromptBaggageSizes(projectRoot, reviewData?.plan?.profile);

  for (const event of usageEvents) {
    const step = byStep.get(event.step) ?? {
      step: event.step,
      runners: [],
      runs: 0,
      wallClockSeconds: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0,
      reviewCycles: reviewStats[event.step]?.reviewCycles ?? 0,
      findings: reviewStats[event.step]?.findings ?? 0,
      severityCounts: reviewStats[event.step]?.severityCounts ?? emptySeverityCounts(),
      commandDurationMs: 0,
      outputChars: 0,
      staticPromptChars: promptSizes[event.step]?.staticPromptChars,
      templateChars: promptSizes[event.step]?.templateChars,
      skillPromptChars: promptSizes[event.step]?.skillPromptChars,
    };
    step.runs += 1;
    step.wallClockSeconds += event.wallClockSeconds;
    step.inputTokens += event.inputTokens;
    step.outputTokens += event.outputTokens;
    step.cacheReadInputTokens += event.cacheReadInputTokens;
    step.cacheCreationInputTokens += event.cacheCreationInputTokens;
    step.costUsd += event.costUsd;
    step.commandDurationMs += event.commandDurationMs ?? 0;
    step.outputChars += event.outputChars ?? 0;
    if (!step.runners.includes(event.runner)) {
      step.runners.push(event.runner);
    }
    byStep.set(event.step, step);
  }

  return [...byStep.values()];
}

function deriveOpportunities(diagnosis: BenchmarkDiagnosis): Opportunity[] {
  const opportunities: Opportunity[] = [];
  const totalWall = diagnosis.steps.reduce((sum, step) => sum + step.wallClockSeconds, 0) || 1;
  const totalCost = diagnosis.steps.reduce((sum, step) => sum + step.costUsd, 0) || 1;

  for (const step of diagnosis.steps) {
    const wallShare = step.wallClockSeconds / totalWall;
    const costShare = step.costUsd / totalCost;
    const cacheRatio = step.inputTokens > 0 ? step.cacheReadInputTokens / step.inputTokens : 0;

    if (wallShare >= 0.30) {
      opportunities.push({
        category: "time",
        step: step.step,
        message: `wall clock の ${Math.round(wallShare * 100)}% を占める。step の簡略化または分割候補。`,
      });
    }
    if (costShare >= 0.25) {
      opportunities.push({
        category: "cost",
        step: step.step,
        message: `cost の ${Math.round(costShare * 100)}% を占める。出力制約か prompt 圧縮候補。`,
      });
    }
    if (step.reviewCycles > 0 && step.findings === 0 && (wallShare >= 0.15 || step.inputTokens >= 50000)) {
      opportunities.push({
        category: "review",
        step: step.step,
        message: `findings 0 件で ${formatDuration(step.wallClockSeconds)} / ${step.inputTokens} input tokens を消費。review 観点の簡略化候補。`,
      });
    }
    if (cacheRatio >= 0.70 || step.cacheReadInputTokens >= 100000) {
      opportunities.push({
        category: "prompt",
        step: step.step,
        message: `cache-read input が ${step.cacheReadInputTokens} tokens。spec / testCases / skill の再送過多候補。`,
      });
    }
    if ((step.staticPromptChars ?? 0) >= 5000) {
      opportunities.push({
        category: "prompt",
        step: step.step,
        message: `テンプレート + skill の静的サイズが ${formatChars(step.staticPromptChars)}。prompt slimming 候補。`,
      });
    }
    if (step.findings === 0 && step.outputTokens >= 5000) {
      opportunities.push({
        category: "prompt",
        step: step.step,
        message: `出力が ${step.outputTokens} tokens だが findings は 0 件。回答形式の冗長化候補。`,
      });
    }
  }

  const implSelfQuality = diagnosis.steps.find((step) => step.step === FLOW_STEP.IMPL_SELF_QUALITY);
  const implExternal = diagnosis.steps.find((step) => step.step === FLOW_STEP.IMPL_EXTERNAL_REVIEW);
  if (implSelfQuality && implExternal && implSelfQuality.findings === 0 && implExternal.findings > 0) {
    opportunities.push({
      category: "review",
      step: FLOW_STEP.IMPL_SELF_QUALITY,
      message: `self review は問題を見つけられず、後段の external review が ${implExternal.findings} 件検出。役割の重複または観点不足を見直す余地がある。`,
    });
  }

  return dedupeOpportunities(opportunities);
}

function computePromptBaggageSizes(
  projectRoot: string,
  profileName: string | undefined,
): Partial<Record<string, { staticPromptChars: number; templateChars: number; skillPromptChars: number }>> {
  if (!profileName) return {};
  try {
    const config = loadConfig(projectRoot);
    const profile = resolveProfile(config, profileName);
    const result: Partial<Record<string, { staticPromptChars: number; templateChars: number; skillPromptChars: number }>> = {};
    for (const step of SUMMARY_STEP_ORDER) {
      const flowStep = step as FlowStep;
      const context = resolveStepContext(profile, flowStep);
      const skillPromptChars = context.skillNames
        .map((skillName) => findSkillFilePath(projectRoot, skillName))
        .filter((filePath): filePath is string => typeof filePath === "string")
        .filter((filePath) => existsSync(filePath))
        .reduce((sum, filePath) => sum + readFileSync(filePath, "utf-8").length, 0);
      const templateChars = uniqueStrings(TEMPLATE_MAP[flowStep] ?? [])
        .reduce((sum, templateName) => {
          try {
            return sum + loadTemplate(templateName, projectRoot, config.templates).length;
          } catch {
            return sum;
          }
        }, 0);
      if (templateChars === 0 && skillPromptChars === 0) continue;
      result[step] = {
        staticPromptChars: templateChars + skillPromptChars,
        templateChars,
        skillPromptChars,
      };
    }
    return result;
  } catch {
    return {};
  }
}

function buildReviewStats(records: ReviewRecordShape[]): Record<string, { reviewCycles: number; findings: number; severityCounts: SeverityCounts }> {
  const result: Record<string, { reviewCycles: number; findings: number; severityCounts: SeverityCounts }> = {};
  for (const record of records) {
    const step = REVIEW_STEP_MAP[record.step];
    if (!step) continue;
    const current = result[step] ?? {
      reviewCycles: 0,
      findings: 0,
      severityCounts: emptySeverityCounts(),
    };
    current.reviewCycles += 1;
    current.findings += record.findings.length;
    for (const finding of record.findings) {
      current.severityCounts[finding.severity] += 1;
    }
    result[step] = current;
  }
  return result;
}

function countActiveReviewCycles(records: ReviewRecordShape[]): number {
  return records.filter((record) => record.step !== "design_decision" && record.decision !== "accepted").length;
}

function readOptionalReviewData(path: string): ReviewDataShape | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as ReviewDataShape;
}

function readHarnessEvents(path: string): HarnessEvent[] {
  if (!existsSync(path)) {
    throw new GuardError(`harness.jsonl が見つかりません: ${path}`);
  }

  return readFileSync(path, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HarnessEvent);
}

function parseRunnerUsageEvents(events: HarnessEvent[]): RunnerUsageEvent[] {
  const result: RunnerUsageEvent[] = [];
  for (const [index, event] of events.entries()) {
    if (event.event !== "runner_usage" || !event.step || !event.runner) {
      continue;
    }
    const previous = events[index - 1];
    result.push({
      ts: event.ts,
      step: event.step,
      runner: event.runner,
      inputTokens: numberOrZero(event.inputTokens),
      outputTokens: numberOrZero(event.outputTokens),
      cacheReadInputTokens: numberOrZero(event.cacheReadInputTokens),
      cacheCreationInputTokens: numberOrZero(event.cacheCreationInputTokens),
      costUsd: numberOrZero(event.costUsd),
      wallClockSeconds: previous ? secondsBetween(previous.ts, event.ts) : 0,
      modelNames: [],
    });
  }
  return result;
}

function pairClaudeCommandDetails(events: RunnerUsageEvent[], logPath: string): void {
  if (!existsSync(logPath)) return;
  const details = parseClaudeCommandLog(logPath);
  const targets = events.filter((event) => event.runner === "claude");
  for (let index = 0; index < Math.min(details.length, targets.length); index++) {
    targets[index].commandDurationMs = details[index].durationMs;
    targets[index].outputChars = details[index].outputChars;
    targets[index].modelNames = details[index].modelNames;
  }
}

function pairCodexTranscriptDetails(events: RunnerUsageEvent[], logPath: string): void {
  if (!existsSync(logPath)) return;
  const details = parseCodexTranscriptLog(logPath);
  const targets = events.filter((event) => event.runner === "codex");
  for (let index = 0; index < Math.min(details.length, targets.length); index++) {
    targets[index].commandDurationMs = details[index].durationMs;
    targets[index].outputChars = details[index].outputChars;
  }
}

function parseClaudeCommandLog(logPath: string): LlmCommandDetail[] {
  const blocks = splitLogBlocks(readFileSync(logPath, "utf-8"));
  const details: LlmCommandDetail[] = [];

  for (const block of blocks) {
    const commandLine = block.find((line) => line.startsWith("Command: "));
    if (!commandLine || !commandLine.startsWith("Command: claude ")) {
      continue;
    }
    const stdout = extractSection(block, "--- stdout ---", "--- stderr ---");
    if (!stdout) continue;
    try {
      const parsed = JSON.parse(stdout) as {
        duration_ms?: number;
        result?: string;
        structured_output?: unknown;
        modelUsage?: Record<string, unknown>;
      };
      const outputText = parsed.result || (parsed.structured_output !== undefined
        ? JSON.stringify(parsed.structured_output)
        : "");
      details.push({
        durationMs: numberOrZero(parsed.duration_ms),
        outputChars: outputText.length,
        modelNames: Object.keys(parsed.modelUsage ?? {}),
      });
    } catch {
      continue;
    }
  }

  return details;
}

function parseCodexTranscriptLog(logPath: string): Array<{ durationMs: number; outputChars: number }> {
  const blocks = splitLogBlocks(readFileSync(logPath, "utf-8"));
  const completedTurns: Array<{ durationMs: number; outputChars: number }> = [];
  const outputByTurn = new Map<string, number>();

  for (const block of blocks) {
    if (block[0] !== "[server]") continue;
    const payload = block.slice(1).join("\n").trim();
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload) as { method?: string; params?: Record<string, any> };
      if (parsed.method === "item/completed" && parsed.params?.item?.type === "agentMessage") {
        const turnId = typeof parsed.params.turnId === "string" ? parsed.params.turnId : "";
        const text = typeof parsed.params.item.text === "string" ? parsed.params.item.text : "";
        outputByTurn.set(turnId, (outputByTurn.get(turnId) ?? 0) + text.length);
      }
      if (parsed.method === "turn/completed") {
        const turnId = typeof parsed.params?.turn?.id === "string" ? parsed.params.turn.id : "";
        completedTurns.push({
          durationMs: numberOrZero(parsed.params?.turn?.durationMs),
          outputChars: outputByTurn.get(turnId) ?? 0,
        });
      }
    } catch {
      continue;
    }
  }

  return completedTurns;
}

function splitLogBlocks(content: string): string[][] {
  return content
    .split(/^=== .+ ===$/m)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => chunk.split("\n"));
}

function extractSection(lines: string[], startMarker: string, endMarker: string): string {
  const start = lines.indexOf(startMarker);
  const end = lines.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) return "";
  return lines.slice(start + 1, end).join("\n").trim();
}

function sortSteps(steps: StepDiagnosis[]): StepDiagnosis[] {
  const order = new Map(SUMMARY_STEP_ORDER.map((step, index) => [step, index]));
  return [...steps].sort((left, right) => {
    const leftOrder = order.get(left.step) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right.step) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.step.localeCompare(right.step);
  });
}

function topStepName<T extends keyof StepDiagnosis>(steps: StepDiagnosis[], field: T): string | null {
  if (steps.length === 0) return null;
  return [...steps].sort((left, right) => numberField(right[field]) - numberField(left[field]))[0]?.step ?? null;
}

function numberField(value: StepDiagnosis[keyof StepDiagnosis]): number {
  return typeof value === "number" ? value : 0;
}

function emptySeverityCounts(): SeverityCounts {
  return { critical: 0, major: 0, minor: 0 };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function secondsBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / 1000;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.round(seconds % 60);
    return `${minutes}m${remainder}s`;
  }
  return `${seconds.toFixed(1)}s`;
}

function formatSigned(value: number, digits = 0): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(digits)}`;
}

function formatSignedDuration(seconds: number): string {
  const prefix = seconds > 0 ? "+" : "";
  const absolute = Math.abs(seconds);
  return `${prefix}${formatDuration(absolute)}`;
}

function formatChars(value: number | undefined): string {
  if (!value) return "n/a";
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function dedupeOpportunities(opportunities: Opportunity[]): Opportunity[] {
  const seen = new Set<string>();
  const result: Opportunity[] = [];
  for (const opportunity of opportunities) {
    const key = `${opportunity.category}:${opportunity.step}:${opportunity.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(opportunity);
  }
  return result;
}
