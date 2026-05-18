import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLOW_STEP } from "../../domain/model/steps.ts";
import { applyStepContext, findSkillFilePath, resolveStepContext } from "./step-context.ts";
import type { ResolvedProfileConfig } from "../config/config.ts";

function makeProfile(): ResolvedProfileConfig {
  return {
    flow: "full",
    fallbackRunner: "codex",
    steps: Object.fromEntries(
      Object.values(FLOW_STEP).map((step) => [step, "codex"]),
    ) as Record<(typeof FLOW_STEP)[keyof typeof FLOW_STEP], string>,
    lint: [{ name: "ruff", args: [] }, { name: "mypy", args: [] }],
    test: "pytest",
    sourceLayout: {
      sourceDir: "backend/{{category}}",
      testDir: "backend/{{category}}/tests",
      scopePattern: "backend/{{category}}/*",
      additionalAllowedPrefixes: [".harness/reviews/"],
    },
    designLayout: {
      specDir: "docs/spec/{{category}}",
      testCaseDir: "tests/test-cases/{{category}}",
    },
    exec: [],
    toolRoot: "/tmp/project",
    reviewCriteria: [],
    criteriaPreset: "backend",
    context: {
      defaultAgent: "general-agent",
      defaultSkills: ["core-skill"],
      defaultMcpConfigs: ["mcp/default.json"],
      stepOverrides: {
        [FLOW_STEP.IMPL_EXTERNAL_REVIEW]: {
          agent: "review-agent",
          model: "claude-opus-4-6",
          skills: ["review-skill"],
          mcpConfigs: ["mcp/review.json"],
        },
      },
    },
  };
}

test("resolveStepContext merges default and per-step context", () => {
  const context = resolveStepContext(makeProfile(), FLOW_STEP.IMPL_EXTERNAL_REVIEW);

  assert.equal(context.agent, "review-agent");
  assert.equal(context.model, "claude-opus-4-6");
  assert.deepEqual(context.skillNames, ["core-skill", "review-skill"]);
  assert.deepEqual(context.mcpConfigs, ["mcp/default.json", "mcp/review.json"]);
});

test("applyStepContext prefers .codex skills, then bundled skills, then .claude skills", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-step-context-"));
  mkdirSync(join(workspace, ".codex", "skills", "core-skill"), { recursive: true });
  mkdirSync(join(workspace, ".harness", "resources", "skills", "bundled-skill"), { recursive: true });
  mkdirSync(join(workspace, ".claude", "skills", "review-skill"), { recursive: true });
  writeFileSync(join(workspace, ".codex", "skills", "core-skill", "SKILL.md"), "core guidance", "utf-8");
  writeFileSync(join(workspace, ".harness", "resources", "skills", "bundled-skill", "SKILL.md"), "bundled guidance", "utf-8");
  writeFileSync(join(workspace, ".claude", "skills", "review-skill", "SKILL.md"), "review guidance", "utf-8");

  assert.equal(
    findSkillFilePath(workspace, "core-skill"),
    join(workspace, ".codex", "skills", "core-skill", "SKILL.md"),
  );
  assert.equal(
    findSkillFilePath(workspace, "bundled-skill"),
    join(workspace, ".harness", "resources", "skills", "bundled-skill", "SKILL.md"),
  );
  assert.equal(
    findSkillFilePath(workspace, "review-skill"),
    join(workspace, ".claude", "skills", "review-skill", "SKILL.md"),
  );

  const request = applyStepContext(
    {
      prompt: "review this",
      appendSystemPrompt: "existing context",
    },
    {
      ...makeProfile(),
      context: {
        ...makeProfile().context!,
        defaultSkills: ["core-skill", "bundled-skill"],
      },
    },
    FLOW_STEP.IMPL_EXTERNAL_REVIEW,
    workspace,
  );

  assert.equal(request.agent, "review-agent");
  assert.equal(request.model, "claude-opus-4-6");
  assert.deepEqual(request.mcpConfigs, ["mcp/default.json", "mcp/review.json"]);
  assert.match(request.appendSystemPrompt ?? "", /core guidance/);
  assert.match(request.appendSystemPrompt ?? "", /bundled guidance/);
  assert.match(request.appendSystemPrompt ?? "", /review guidance/);
  assert.match(request.appendSystemPrompt ?? "", /existing context/);
});
