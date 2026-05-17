import type { Runner, RunnerResponse } from "./runner.ts";
import { spawnWithStdin } from "../process/spawn.ts";
import { HarnessError } from "../../domain/model/types.ts";

export type GenericRunnerConfig = {
  name: string;
  command: string;
  args: string[];
  promptFlag?: string;
  timeoutMs?: number;
};

export function createGenericRunner(config: GenericRunnerConfig): Runner {
  return {
    name: config.name,
    capabilities: new Set([]),
    async run(request, logger) {
      const args = [...config.args];
      let stdinData: string;

      if (config.promptFlag) {
        args.push(config.promptFlag, request.prompt);
        stdinData = "";
      } else {
        stdinData = request.appendSystemPrompt
          ? `${request.prompt}\n\n---\n${request.appendSystemPrompt}`
          : request.prompt;
      }

      const result = await spawnWithStdin(
        config.command, args, stdinData,
        request.cwd, request.timeoutMs ?? config.timeoutMs,
      );

      if (logger) logger.logCommand(config.name, args, result);

      if (result.exitCode !== 0) {
        throw new HarnessError(`${config.name} failed (exit ${result.exitCode}): ${result.stderr}`);
      }

      return { text: result.stdout } satisfies RunnerResponse;
    },
  };
}
