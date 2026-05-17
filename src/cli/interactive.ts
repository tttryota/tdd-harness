import { createInterface } from "node:readline/promises";
import type { FlowMode, FlowStep } from "../domain/model/steps.ts";
import { LIGHT_SKIP_STEPS } from "../domain/model/steps.ts";

type InteractiveConsole = Pick<typeof console, "log">;
type InteractiveReadline = {
  question(prompt: string): Promise<string>;
  close(): void;
};

export type InteractiveDeps = {
  createInterfaceImpl?: typeof createInterface;
  consoleImpl?: InteractiveConsole;
};

export async function interactiveRunnerAssignment(
  runnerNames: string[],
  stepMapping: Record<FlowStep, string>,
  flowMode: FlowMode,
  deps: InteractiveDeps = {},
): Promise<Partial<Record<FlowStep, string>> | null> {
  const rl = (deps.createInterfaceImpl ?? createInterface)({
    input: process.stdin,
    output: process.stdout,
  }) as InteractiveReadline;
  const consoleImpl = deps.consoleImpl ?? console;

  const steps = Object.entries(stepMapping)
    .filter(([step]) => !(flowMode === "light" && LIGHT_SKIP_STEPS.has(step as FlowStep)))
    .map(([step, runner], i) => ({ index: i + 1, step: step as FlowStep, runner: runner as string }));

  consoleImpl.log(`\nフロー: ${flowMode}`);
  consoleImpl.log("ステップ割り当て:");
  for (const s of steps) {
    consoleImpl.log(`  ${s.index}. ${s.step}: ${s.runner}`);
  }

  const overrides: Partial<Record<FlowStep, string>> = {};

  while (true) {
    const answer = await rl.question("\n変更するステップ番号を入力 (Enter でそのまま実行): ");
    if (!answer.trim()) break;

    const num = parseInt(answer.trim(), 10);
    const target = steps.find(s => s.index === num);
    if (!target) {
      consoleImpl.log(`無効な番号です。1-${steps.length} を入力してください。`);
      continue;
    }

    const runnerAnswer = await rl.question(`${target.step} のランナー [${runnerNames.join("/")}]: `);
    if (runnerNames.includes(runnerAnswer.trim())) {
      overrides[target.step] = runnerAnswer.trim();
      target.runner = runnerAnswer.trim();
      consoleImpl.log(`  ${target.index}. ${target.step}: ${target.runner}`);
    } else {
      consoleImpl.log("無効なランナー名です。");
    }
  }

  rl.close();
  if (Object.keys(overrides).length === 0) return null;
  return overrides;
}
