import test from "node:test";
import assert from "node:assert/strict";
import { createRunnerRegistry } from "./runner-registry.ts";
import { FLOW_STEP } from "../../domain/model/steps.ts";
import { HarnessError } from "../../domain/model/types.ts";

function baseProfile() {
  return {
    flow: "full",
    fallbackRunner: "claude",
    steps: {
      [FLOW_STEP.TEST_GENERATE]: "claude",
      [FLOW_STEP.TEST_SELF_QUALITY]: "claude",
      [FLOW_STEP.TEST_EXTERNAL_REVIEW]: "codex",
      [FLOW_STEP.IMPL_GENERATE]: "generic",
      [FLOW_STEP.IMPL_SELF_CRITERIA]: "claude",
      [FLOW_STEP.IMPL_SELF_QUALITY]: "claude",
      [FLOW_STEP.IMPL_EXTERNAL_REVIEW]: "codex",
      [FLOW_STEP.LINT_FIX]: "generic",
      [FLOW_STEP.APPLY_FIXES]: "generic",
      [FLOW_STEP.JUDGE_MINOR]: "claude",
      [FLOW_STEP.SPEC_GENERATE]: "claude",
      [FLOW_STEP.SPEC_REVIEW]: "claude",
      [FLOW_STEP.TEST_CASE_GENERATE]: "claude",
      [FLOW_STEP.SPEC_TC_REVIEW]: "claude",
      [FLOW_STEP.COMPONENT_GENERATE]: "generic",
      [FLOW_STEP.COMPONENT_SELF_REVIEW]: "claude",
      [FLOW_STEP.PAGE_GENERATE]: "generic",
      [FLOW_STEP.PAGE_REVIEW_DESIGN]: "codex",
      [FLOW_STEP.PAGE_REVIEW_BEHAVIOR]: "codex",
      [FLOW_STEP.PAGE_REVIEW_CODE]: "codex",
      [FLOW_STEP.PAGE_BROWSER_VERIFY]: "generic",
    },
  } as any;
}

test("createRunnerRegistry resolves configured runners and flow mode overrides", async () => {
  const registry = createRunnerRegistry(
    {
      runners: {
        claude: { type: "claude", timeoutMs: 1000 },
        codex: { type: "codex", sandbox: "read-only", timeoutMs: 2000 },
        generic: { type: "generic", command: process.execPath, args: ["-e", "process.stdout.write('ok')"] },
      },
    } as any,
    "/repo",
    baseProfile(),
    { [FLOW_STEP.TEST_GENERATE]: "generic" },
    "light",
  );

  assert.equal(registry.getFlowMode(), "light");
  assert.equal(registry.isStepSkipped(FLOW_STEP.TEST_EXTERNAL_REVIEW), true);
  assert.equal(registry.getStepMapping()[FLOW_STEP.TEST_GENERATE], "generic");
  assert.equal(registry.getConfig().runners.codex.type, "codex");

  const runner = registry.getRunner(FLOW_STEP.TEST_GENERATE);
  const response = await runner.run({ prompt: "prompt" });

  assert.equal(response.text, "ok");
});

test("wrapped review runners log metadata and unsupported review APIs fail closed", async () => {
  const registry = createRunnerRegistry(
    {
      runners: {
        claude: { type: "claude", timeoutMs: 1000 },
        generic: { type: "generic", command: process.execPath, args: ["-e", "process.stdout.write('ok')"] },
      },
    } as any,
    "/repo",
    {
      ...baseProfile(),
      steps: {
        ...baseProfile().steps,
        [FLOW_STEP.TEST_GENERATE]: "generic",
      },
    },
  );

  const genericRunner = registry.getRunner(FLOW_STEP.TEST_GENERATE);
  await assert.rejects(
    () => genericRunner.review!({ instructions: "review" }, undefined),
    (error: unknown) => error instanceof HarnessError && error.message.includes("does not support review API"),
  );
});

test("runner lookups fail when the assigned runner is missing", () => {
  const registry = createRunnerRegistry(
    { runners: { claude: { type: "claude" } } } as any,
    "/repo",
    {
      ...baseProfile(),
      fallbackRunner: "missing",
      steps: {
        ...baseProfile().steps,
        [FLOW_STEP.TEST_GENERATE]: "missing",
      },
    },
  );

  assert.throws(() => registry.getRunner(FLOW_STEP.TEST_GENERATE), /Runner not found: missing/);
  assert.throws(() => registry.getRunnerByName("missing"), /Runner not found: missing/);
  assert.throws(() => registry.getFallbackRunner(), /Runner not found: missing/);
});
