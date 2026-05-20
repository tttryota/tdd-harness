import test from "node:test";
import assert from "node:assert/strict";
import { interactiveRunnerAssignment } from "./interactive.ts";
import { FLOW_STEP } from "../domain/model/steps.ts";

function stepMapping() {
  return {
    [FLOW_STEP.TEST_GENERATE]: "codex",
    [FLOW_STEP.TEST_SELF_QUALITY]: "codex",
    [FLOW_STEP.TEST_EXTERNAL_REVIEW]: "claude",
    [FLOW_STEP.IMPL_GENERATE]: "codex",
    [FLOW_STEP.IMPL_SELF_CRITERIA]: "codex",
    [FLOW_STEP.IMPL_SELF_QUALITY]: "codex",
    [FLOW_STEP.IMPL_EXTERNAL_REVIEW]: "claude",
    [FLOW_STEP.LINT_FIX]: "codex",
    [FLOW_STEP.APPLY_FIXES]: "codex",
    [FLOW_STEP.JUDGE_MINOR]: "codex",
    [FLOW_STEP.SPEC_GENERATE]: "codex",
    [FLOW_STEP.SPEC_REVIEW]: "codex",
    [FLOW_STEP.TEST_CASE_GENERATE]: "codex",
    [FLOW_STEP.SPEC_TC_REVIEW]: "codex",
    [FLOW_STEP.COMPONENT_GENERATE]: "codex",
    [FLOW_STEP.COMPONENT_SELF_REVIEW]: "codex",
    [FLOW_STEP.PAGE_GENERATE]: "codex",
    [FLOW_STEP.PAGE_REVIEW_DESIGN]: "claude",
    [FLOW_STEP.PAGE_REVIEW_BEHAVIOR]: "claude",
    [FLOW_STEP.PAGE_REVIEW_CODE]: "claude",
    [FLOW_STEP.PAGE_BROWSER_VERIFY]: "codex",
  } as const;
}

test("interactiveRunnerAssignment returns null when the user accepts the current mapping", async () => {
  const prompts: string[] = [];
  const logs: string[] = [];
  const result = await interactiveRunnerAssignment(
    ["codex", "claude"],
    stepMapping() as any,
    "light",
    {
      createInterfaceImpl: () => ({
        async question(prompt: string) {
          prompts.push(prompt);
          return "";
        },
        close() {},
      }) as any,
      consoleImpl: { log: (line: string) => logs.push(line) },
    },
  );

  assert.equal(result, null);
  assert.equal(prompts.length, 1);
  assert.match(logs[0] ?? "", /フロー: light/);
  assert.equal(logs.some((line) => line.includes(FLOW_STEP.TEST_EXTERNAL_REVIEW)), false);
});

test("interactiveRunnerAssignment rejects invalid input and returns explicit overrides", async () => {
  const answers = ["99", "1", "bad", "1", "claude", ""];
  const logs: string[] = [];
  const result = await interactiveRunnerAssignment(
    ["codex", "claude"],
    stepMapping() as any,
    "full",
    {
      createInterfaceImpl: () => ({
        async question() {
          return answers.shift() ?? "";
        },
        close() {},
      }) as any,
      consoleImpl: { log: (line: string) => logs.push(line) },
    },
  );

  assert.deepEqual(result, {
    [FLOW_STEP.TEST_GENERATE]: "claude",
  });
  assert.equal(logs.some((line) => line.includes("無効な番号です")), true);
  assert.equal(logs.some((line) => line.includes("無効なランナー名です")), true);
  assert.equal(logs.some((line) => line.includes(`${FLOW_STEP.TEST_GENERATE}: claude`)), true);
});
