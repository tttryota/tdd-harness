import type { Runner, RunnerRequest, RunnerResponse } from "./runner.ts";
import { prepareRequest } from "./runner.ts";
import type { FlowStep, FlowMode } from "../../domain/model/steps.ts";
import { LIGHT_SKIP_STEPS } from "../../domain/model/steps.ts";
import type { HarnessConfig, ResolvedProfileConfig } from "../config/config.ts";
import { createClaudeRunner } from "./claude-runner.ts";
import { createCodexRunner } from "./codex-runner.ts";
import { createGenericRunner } from "./generic-runner.ts";
import { HarnessError } from "../../domain/model/types.ts";
import { EVENT } from "../../domain/model/types.ts";
import type { RunnerReviewRequest } from "./runner.ts";
import type { Logger } from "../../application/ports/logger.ts";

export type RunnerRegistry = {
  getRunner(step: FlowStep): Runner;
  getRunnerByName(name: string): Runner;
  isStepSkipped(step: FlowStep): boolean;
  getFlowMode(): FlowMode;
  getStepMapping(): Record<string, string>;
  getFallbackRunner(): Runner;
  getConfig(): HarnessConfig;
};

export function createRunnerRegistry(
  config: HarnessConfig,
  projectRoot: string,
  profile: ResolvedProfileConfig,
  overrides?: Partial<Record<FlowStep, string>>,
  flowMode?: FlowMode,
): RunnerRegistry {
  const runners = new Map<string, Runner>();

  for (const [name, rc] of Object.entries(config.runners)) {
    switch (rc.type) {
      case "claude":
        runners.set(name, createClaudeRunner({ timeoutMs: rc.timeoutMs, model: rc.model }));
        break;
      case "codex":
        runners.set(name, createCodexRunner({
          timeoutMs: rc.timeoutMs,
          sandbox: rc.sandbox,
          projectRoot,
          model: rc.model,
          approvalPolicy: rc.approvalPolicy,
          summary: rc.summary,
          effort: rc.effort,
          personality: rc.personality,
        }));
        break;
      case "generic":
        runners.set(name, createGenericRunner({
          name, command: rc.command, args: rc.args,
          promptFlag: rc.promptFlag, timeoutMs: rc.timeoutMs,
        }));
        break;
    }
  }

  const stepMapping: Record<string, string> = {
    ...profile.steps, ...overrides,
  } as Record<string, string>;
  const effectiveFlowMode = flowMode ?? profile.flow;

  function wrapRunner(runner: Runner, step?: FlowStep): Runner {
    return {
      name: runner.name,
      capabilities: runner.capabilities,
      async run(request: RunnerRequest, logger?: Logger): Promise<RunnerResponse> {
        const response = await runner.run(prepareRequest(runner, request), logger);
        if (logger && response.metadata && step) {
          logger.log(EVENT.RUNNER_USAGE, {
            step,
            runner: runner.name,
            inputTokens: response.metadata.inputTokens ?? null,
            outputTokens: response.metadata.outputTokens ?? null,
            cacheCreationInputTokens: response.metadata.cacheCreationInputTokens ?? null,
            cacheReadInputTokens: response.metadata.cacheReadInputTokens ?? null,
            costUsd: response.metadata.costUsd ?? null,
          });
        }
        return response;
      },
      async review(request: RunnerReviewRequest, logger?: Logger): Promise<RunnerResponse> {
        if (!runner.review) {
          throw new HarnessError(`Runner does not support review API: ${runner.name}`);
        }
        const response = await runner.review(request, logger);
        if (logger && response.metadata && step) {
          logger.log(EVENT.RUNNER_USAGE, {
            step,
            runner: runner.name,
            inputTokens: response.metadata.inputTokens ?? null,
            outputTokens: response.metadata.outputTokens ?? null,
            cacheCreationInputTokens: response.metadata.cacheCreationInputTokens ?? null,
            cacheReadInputTokens: response.metadata.cacheReadInputTokens ?? null,
            costUsd: response.metadata.costUsd ?? null,
          });
        }
        return response;
      },
    };
  }

  function resolveRunner(name: string): Runner {
    const runner = runners.get(name);
    if (!runner) throw new HarnessError(`Runner not found: ${name}`);
    return wrapRunner(runner);
  }

  return {
    getRunner(step: FlowStep): Runner {
      const runnerName = stepMapping[step];
      if (!runnerName) throw new HarnessError(`No runner assigned for step: ${step}`);
      const runner = runners.get(runnerName);
      if (!runner) throw new HarnessError(`Runner not found: ${runnerName}`);
      return wrapRunner(runner, step);
    },
    getRunnerByName(name: string): Runner {
      return resolveRunner(name);
    },
    isStepSkipped(step: FlowStep): boolean {
      return effectiveFlowMode === "light" && LIGHT_SKIP_STEPS.has(step);
    },
    getFallbackRunner(): Runner {
      return resolveRunner(profile.fallbackRunner);
    },
    getFlowMode: () => effectiveFlowMode,
    getStepMapping: () => ({ ...stepMapping }),
    getConfig: () => config,
  };
}
