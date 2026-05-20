import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inferProfile, loadConfig, resolveProfile } from "./config.ts";
import { GuardError } from "../../domain/model/types.ts";

function writeConfig(workspace: string, body: string): void {
  mkdirSync(join(workspace, ".harness", "config"), { recursive: true });
  writeFileSync(join(workspace, ".harness", "config", "harness.yml"), body, "utf-8");
}

function baseYaml(): string {
  return `profiles:
  backend:
    flow: full
    fallbackRunner: codex
    steps:
      test_generate: codex
      test_self_quality: codex
      test_external_review: claude
      impl_generate: codex
      impl_self_criteria: codex
      impl_self_quality: codex
      impl_external_review: claude
      lint_fix: codex
      apply_fixes: codex
      judge_minor: codex
      spec_generate: codex
      test_case_generate: codex
      spec_tc_review: codex
      component_generate: codex
      component_self_review: codex
      page_generate: codex
      page_review_design: codex
      page_review_behavior: codex
      page_review_code: codex
      page_browser_verify: codex
    lint: [ruff, mypy]
    test: pytest
    toolRoot: backend
    criteriaPreset: backend
    context:
      defaultSkills: [backend-review]
      stepOverrides:
        impl_external_review:
          agent: harness-backend-reviewer
          model: claude-opus-4-6
          skills: [backend-review-quality]
runners:
  claude:
    type: claude
  codex:
    type: codex
    sandbox: workspace-write
`;
}

function replaceRunners(body: string, runnersBlock: string): string {
  return body.replace(/runners:\n[\s\S]*$/, runnersBlock);
}

test("loadConfig resolves profile-centric runner mapping and context", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeConfig(workspace, baseYaml());

  const config = loadConfig(workspace);

  assert.deepEqual(Object.keys(config.profiles), ["backend"]);
  assert.equal(config.profiles.backend.flow, "full");
  assert.equal(config.profiles.backend.fallbackRunner, "codex");
  assert.equal(config.profiles.backend.steps.impl_external_review, "claude");
  assert.deepEqual(config.profiles.backend.lint, [
    { name: "ruff", args: [] },
    { name: "mypy", args: [] },
  ]);
  assert.deepEqual(config.profiles.backend.designLayout, {
    specDir: "docs/spec/{{category}}",
    testCaseDir: "tests/test-cases/{{category}}",
  });
  assert.equal(
    config.profiles.backend.context?.stepOverrides.impl_external_review?.model,
    "claude-opus-4-6",
  );
  assert.deepEqual(config.profiles.backend.context?.defaultSkills, ["backend-review"]);
  assert.deepEqual(
    config.profiles.backend.context?.stepOverrides.impl_external_review?.skills,
    ["backend-review-quality"],
  );
});

test("loadConfig rejects missing profile step assignments", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-missing-step-"));
  writeConfig(
    workspace,
    baseYaml().replace("      page_review_code: codex\n", ""),
  );

  assert.throws(
    () => loadConfig(workspace),
    (error: unknown) =>
      error instanceof GuardError &&
      error.message.includes("profile \"backend\".steps に不足している step"),
  );
});

test("loadConfig rejects legacy top-level runner fields", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-legacy-top-"));
  writeConfig(
    workspace,
    `${baseYaml()}flow: full\n`,
  );

  assert.throws(
    () => loadConfig(workspace),
    (error: unknown) =>
      error instanceof GuardError &&
      error.message.includes("flow はトップレベルでは使えません"),
  );
});

test("loadConfig rejects legacy profile.claude config", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-legacy-profile-"));
  writeConfig(
    workspace,
    `profiles:
  backend:
    flow: full
    fallbackRunner: claude
    steps:
      test_generate: claude
      test_self_quality: claude
      test_external_review: claude
      impl_generate: claude
      impl_self_criteria: claude
      impl_self_quality: claude
      impl_external_review: claude
      lint_fix: claude
      apply_fixes: claude
      judge_minor: claude
      spec_generate: claude
      test_case_generate: claude
      spec_tc_review: claude
      component_generate: claude
      component_self_review: claude
      page_generate: claude
      page_review_design: claude
      page_review_behavior: claude
      page_review_code: claude
      page_browser_verify: claude
    claude:
      defaultAgent: old
runners:
  claude:
    type: claude
`,
  );

  assert.throws(
    () => loadConfig(workspace),
    (error: unknown) =>
      error instanceof GuardError &&
      error.message.includes("profile \"backend\".claude は廃止されました"),
  );
});

test("loadConfig reads .harness/config/harness.yml and preserves template overrides", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-path-"));
  writeConfig(workspace, `${baseYaml()}templates:\n  review-response-format: custom.md\n`);

  const config = loadConfig(workspace);

  assert.equal(config.templates["review-response-format"], "custom.md");
  assert.equal(config.profiles.backend.toolRoot, join(workspace, "backend"));
});

test("loadConfig rejects invalid top-level config shapes", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-shapes-"));
  writeConfig(workspace, "profiles: []\n");
  assert.throws(() => loadConfig(workspace), /profiles はオブジェクト形式/);

  writeConfig(workspace, `${baseYaml()}templates: []\n`);
  assert.throws(() => loadConfig(workspace), /templates はオブジェクト形式/);

  writeConfig(workspace, replaceRunners(baseYaml(), "runners: []\n"));
  assert.throws(() => loadConfig(workspace), /runners はオブジェクト形式/);
});

test("loadConfig rejects invalid profile field shapes", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-profile-shape-"));
  const cases = [
    {
      name: "bad flow",
      body: baseYaml().replace("    flow: full", "    flow: invalid"),
      pattern: /flow は "full" または "light"/,
    },
    {
      name: "missing fallback runner",
      body: baseYaml().replace("    fallbackRunner: codex\n", ""),
      pattern: /fallbackRunner は空でない文字列/,
    },
    {
      name: "non-array lint",
      body: baseYaml().replace("    lint: [ruff, mypy]", "    lint: ruff"),
      pattern: /\.lint は配列で指定してください/,
    },
    {
      name: "invalid lint object",
      body: baseYaml().replace("    lint: [ruff, mypy]", "    lint:\n      - {}\n"),
      pattern: /\.lint\[\]\.name は空でない文字列/,
    },
    {
      name: "invalid lint args shape",
      body: baseYaml().replace("    lint: [ruff, mypy]", "    lint:\n      - name: ruff\n        args: bad\n"),
      pattern: /\.lint\[\]\.args は文字列配列/,
    },
    {
      name: "non-string test",
      body: baseYaml().replace("    test: pytest", "    test: 1"),
      pattern: /\.test は文字列で指定してください/,
    },
    {
      name: "invalid criteria preset",
      body: baseYaml().replace("    criteriaPreset: backend", "    criteriaPreset: mobile"),
      pattern: /\.criteriaPreset は "backend" または "frontend"/,
    },
    {
      name: "invalid sourceLayout shape",
      body: baseYaml().replace("    toolRoot: backend\n", "    toolRoot: backend\n    sourceLayout: []\n"),
      pattern: /\.sourceLayout はオブジェクト形式/,
    },
    {
      name: "invalid designLayout shape",
      body: baseYaml().replace("    toolRoot: backend\n", "    toolRoot: backend\n    designLayout: []\n"),
      pattern: /\.designLayout はオブジェクト形式/,
    },
    {
      name: "invalid designLayout specDir",
      body: baseYaml().replace("    toolRoot: backend\n", "    toolRoot: backend\n    designLayout:\n      specDir: 1\n"),
      pattern: /\.designLayout\.specDir は文字列/,
    },
    {
      name: "invalid storybook shape",
      body: baseYaml().replace("    toolRoot: backend\n", "    toolRoot: backend\n    storybook: []\n"),
      pattern: /\.storybook はオブジェクト形式/,
    },
    {
      name: "invalid toolRoot",
      body: baseYaml().replace("    toolRoot: backend", "    toolRoot: 1"),
      pattern: /\.toolRoot は文字列/,
    },
  ];

  for (const entry of cases) {
    writeConfig(workspace, entry.body);
    assert.throws(() => loadConfig(workspace), entry.pattern, entry.name);
  }
});

test("loadConfig rejects invalid context and runner definitions", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-context-runner-"));
  const cases = [
    {
      name: "invalid default skills",
      body: baseYaml().replace("      defaultSkills: [backend-review]", "      defaultSkills: []"),
      pattern: /\.defaultSkills は空でない文字列配列/,
    },
    {
      name: "unknown override step",
      body: baseYaml().replace("        impl_external_review:", "        unknown_step:"),
      pattern: /未知の step "unknown_step"/,
    },
    {
      name: "invalid override model",
      body: baseYaml().replace("          model: claude-opus-4-6\n", "          model: 1\n"),
      pattern: /\.stepOverrides\.impl_external_review\.model は文字列/,
    },
    {
      name: "invalid generic command",
      body: `${baseYaml()}  generic:\n    type: generic\n    command: ''\n    args: []\n`,
      pattern: /type: generic\) には command/,
    },
    {
      name: "invalid generic args",
      body: `${baseYaml()}  generic:\n    type: generic\n    command: echo\n    args: bad\n`,
      pattern: /type: generic\) には args/,
    },
    {
      name: "invalid codex policy",
      body: baseYaml().replace("    sandbox: workspace-write", "    sandbox: workspace-write\n    approvalPolicy: always"),
      pattern: /approvalPolicy は untrusted\/on-failure\/on-request\/never/,
    },
    {
      name: "invalid codex effort",
      body: baseYaml().replace("    sandbox: workspace-write", "    sandbox: workspace-write\n    effort: xhigh"),
      pattern: /effort は minimal\/low\/medium\/high/,
    },
    {
      name: "invalid codex personality",
      body: baseYaml().replace("    sandbox: workspace-write", "    sandbox: workspace-write\n    personality: custom"),
      pattern: /personality は default\/strict\/balanced/,
    },
  ];

  for (const entry of cases) {
    writeConfig(workspace, entry.body);
    assert.throws(() => loadConfig(workspace), entry.pattern, entry.name);
  }
});

test("loadConfig rejects runtime mismatches and invalid path templates", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-runtime-"));
  writeConfig(workspace, baseYaml().replace("    lint: [ruff, mypy]", "    lint: [ruff, eslint]"));
  assert.throws(() => loadConfig(workspace), /異なる runtime の lint ツールを混在/);

  writeConfig(workspace, baseYaml().replace("    test: pytest", "    test: vitest"));
  assert.throws(() => loadConfig(workspace), /lint runtime \(python\) と test runtime \(node\) が一致しません/);

  writeConfig(
    workspace,
    `profiles:
  backend:
    flow: full
    fallbackRunner: codex
    steps:
      test_generate: codex
      test_self_quality: codex
      test_external_review: claude
      impl_generate: codex
      impl_self_criteria: codex
      impl_self_quality: codex
      impl_external_review: claude
      lint_fix: codex
      apply_fixes: codex
      judge_minor: codex
      spec_generate: codex
      test_case_generate: codex
      spec_tc_review: codex
      component_generate: codex
      component_self_review: codex
      page_generate: codex
      page_review_design: codex
      page_review_behavior: codex
      page_review_code: codex
      page_browser_verify: codex
    lint: [ruff, mypy]
    test: pytest
    toolRoot: backend
    criteriaPreset: backend
    sourceLayout:
      sourceDir: "../backend"
      testDir: "backend/tests"
      scopePattern: "backend/*"
runners:
  claude:
    type: claude
  codex:
    type: codex
    sandbox: workspace-write
`,
  );
  assert.throws(() => loadConfig(workspace), /"\.\." を含むパスは指定できません/);

  writeConfig(
    workspace,
    `profiles:
  backend:
    flow: full
    fallbackRunner: codex
    steps:
      test_generate: codex
      test_self_quality: codex
      test_external_review: claude
      impl_generate: codex
      impl_self_criteria: codex
      impl_self_quality: codex
      impl_external_review: claude
      lint_fix: codex
      apply_fixes: codex
      judge_minor: codex
      spec_generate: codex
      test_case_generate: codex
      spec_tc_review: codex
      component_generate: codex
      component_self_review: codex
      page_generate: codex
      page_review_design: codex
      page_review_behavior: codex
      page_review_code: codex
      page_browser_verify: codex
    lint: [ruff, mypy]
    test: pytest
    toolRoot: backend
    criteriaPreset: backend
    sourceLayout:
      sourceDir: "backend"
      testDir: "backend/tests"
      scopePattern: "backend"
runners:
  claude:
    type: claude
  codex:
    type: codex
    sandbox: workspace-write
`,
  );
  assert.throws(() => loadConfig(workspace), /scopePattern の末尾は "\/\*" または "\/\*\*"/);

  writeConfig(
    workspace,
    `${baseYaml().replace("    toolRoot: backend\n", `    toolRoot: backend\n    designLayout:\n      specDir: \"../docs/spec\"\n`)}`
  );
  assert.throws(() => loadConfig(workspace), /"\.\." を含むパスは指定できません/);
});

test("loadConfig infers defaults, profile resolution, and missing profile guidance", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-defaults-"));
  writeConfig(
    workspace,
    `profiles:
  backend:
    flow: full
    fallbackRunner: claude
    steps:
      test_generate: claude
      test_self_quality: claude
      test_external_review: claude
      impl_generate: claude
      impl_self_criteria: claude
      impl_self_quality: claude
      impl_external_review: claude
      lint_fix: claude
      apply_fixes: claude
      judge_minor: claude
      spec_generate: claude
      test_case_generate: claude
      spec_tc_review: claude
      component_generate: claude
      component_self_review: claude
      page_generate: claude
      page_review_design: claude
      page_review_behavior: claude
      page_review_code: claude
      page_browser_verify: claude
runners:
  claude:
    type: claude
`,
  );

  const config = loadConfig(workspace);
  assert.deepEqual(config.profiles.backend.lint, [
    { name: "ruff", args: [] },
    { name: "mypy", args: [] },
  ]);
  assert.equal(config.profiles.backend.test, "pytest");
  assert.deepEqual(config.profiles.backend.designLayout, {
    specDir: "docs/spec/{{category}}",
    testCaseDir: "tests/test-cases/{{category}}",
  });
  assert.equal(inferProfile(config), "backend");
  assert.equal(resolveProfile(config, "backend").fallbackRunner, "claude");

  assert.throws(
    () => loadConfig(mkdtempSync(join(tmpdir(), "harness-config-missing-profiles-"))),
    /`\.\/\.harness\/bin\/harness init`/,
  );
  assert.throws(() => resolveProfile(config, "missing"), /profile "missing" が見つかりません/);
});

test("inferProfile requires an explicit frontmatter profile when multiple profiles exist", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-multi-"));
  writeConfig(
    workspace,
    `profiles:
  backend:
    flow: full
    fallbackRunner: codex
    steps:
      test_generate: codex
      test_self_quality: codex
      test_external_review: claude
      impl_generate: codex
      impl_self_criteria: codex
      impl_self_quality: codex
      impl_external_review: claude
      lint_fix: codex
      apply_fixes: codex
      judge_minor: codex
      spec_generate: codex
      test_case_generate: codex
      spec_tc_review: codex
      component_generate: codex
      component_self_review: codex
      page_generate: codex
      page_review_design: codex
      page_review_behavior: codex
      page_review_code: codex
      page_browser_verify: codex
    lint: [ruff, mypy]
    test: pytest
    toolRoot: backend
    criteriaPreset: backend
    sourceLayout:
      sourceDir: "backend/{{category}}"
      testDir: "backend/{{category}}/tests"
      scopePattern: "backend/{{category}}/*"
  frontend:
    flow: light
    fallbackRunner: codex
    steps:
      test_generate: codex
      test_self_quality: codex
      test_external_review: claude
      impl_generate: codex
      impl_self_criteria: codex
      impl_self_quality: codex
      impl_external_review: claude
      lint_fix: codex
      apply_fixes: codex
      judge_minor: codex
      spec_generate: codex
      test_case_generate: codex
      spec_tc_review: codex
      component_generate: codex
      component_self_review: codex
      page_generate: codex
      page_review_design: codex
      page_review_behavior: codex
      page_review_code: codex
      page_browser_verify: codex
    lint: [eslint, tsc]
    test: vitest
    toolRoot: frontend
    criteriaPreset: frontend
    sourceLayout:
      sourceDir: "frontend/src/{{category}}/{{name}}"
      testDir: "frontend/src/{{category}}/{{name}}/__tests__"
      scopePattern: "frontend/src/{{category}}/{{name}}/*"
runners:
  claude:
    type: claude
  codex:
    type: codex
    sandbox: workspace-write
`,
  );

  const config = loadConfig(workspace);
  assert.throws(() => inferProfile(config), /複数の profile があります/);
});

test("loadConfig preserves explicit designLayout overrides", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-design-layout-"));
  writeConfig(
    workspace,
    baseYaml().replace(
      "    criteriaPreset: backend\n",
      "    criteriaPreset: backend\n    designLayout:\n      specDir: docs/spec/backend/{{category}}\n      testCaseDir: backend/{{category}}/docs/test-cases\n",
    ),
  );

  const config = loadConfig(workspace);

  assert.deepEqual(config.profiles.backend.designLayout, {
    specDir: "docs/spec/backend/{{category}}",
    testCaseDir: "backend/{{category}}/docs/test-cases",
  });
});

test("loadConfig preserves explicit lint args overrides", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-config-lint-args-"));
  writeConfig(
    workspace,
    baseYaml().replace(
      "    lint: [ruff, mypy]\n",
      "    lint:\n      - name: ruff\n        args: [--ignore, BLE001]\n      - mypy\n      - name: mypy\n        args: [--disable-error-code, call-arg]\n",
    ),
  );

  const config = loadConfig(workspace);

  assert.deepEqual(config.profiles.backend.lint, [
    { name: "ruff", args: ["--ignore", "BLE001"] },
    { name: "mypy", args: [] },
    { name: "mypy", args: ["--disable-error-code", "call-arg"] },
  ]);
});
