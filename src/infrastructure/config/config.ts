import { readFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { HarnessError, GuardError } from "../../domain/model/types.ts";
import { LINT_REGISTRY, TEST_REGISTRY } from "../tooling/tool-adapter.ts";
import { FLOW_MODE, FLOW_STEP } from "../../domain/model/steps.ts";
import type { FlowMode, FlowStep } from "../../domain/model/steps.ts";

export type RunnerConfig =
  | { type: "claude"; timeoutMs?: number; model?: string }
  | {
      type: "codex";
      sandbox?: string;
      timeoutMs?: number;
      model?: string;
      approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
      summary?: "auto" | "brief" | "detailed";
      effort?: "minimal" | "low" | "medium" | "high";
      personality?: "default" | "strict" | "balanced";
    }
  | {
      type: "generic";
      command: string;
      args: string[];
      promptFlag?: string;
      timeoutMs?: number;
    };

export type UserSourceLayoutConfig = {
  sourceDir?: string;
  testDir?: string;
  scopePattern?: string;
  additionalAllowedPrefixes?: string[];
};

export type UserDesignLayoutConfig = {
  specDir?: string;
  testCaseDir?: string;
};

export type UserLintToolConfig =
  | string
  | {
      name: string;
      args?: string[];
    };

export type UserStorybookConfig = {
  renderCommand?: string[];
  smokeCommand?: string[];
};

export type UserStepContextOverrideConfig = {
  agent?: string;
  skills?: string[];
  mcpConfigs?: string[];
  model?: string;
};

export type UserProfileContextConfig = {
  defaultAgent?: string;
  defaultSkills?: string[];
  defaultMcpConfigs?: string[];
  stepOverrides?: Partial<Record<FlowStep, UserStepContextOverrideConfig>>;
};

export type SourceLayoutConfig = {
  sourceDir: string;
  testDir: string;
  scopePattern: string;
  additionalAllowedPrefixes: string[];
};

export type DesignLayoutConfig = {
  specDir: string;
  testCaseDir: string;
};

export type ResolvedLintToolConfig = {
  name: string;
  args: string[];
};

export type StorybookConfig = {
  renderCommand: string[];
  smokeCommand: string[];
};

export type StepContextOverrideConfig = {
  agent?: string;
  skills: string[];
  mcpConfigs: string[];
  model?: string;
};

export type ProfileContextConfig = {
  defaultAgent?: string;
  defaultSkills: string[];
  defaultMcpConfigs: string[];
  stepOverrides: Partial<Record<FlowStep, StepContextOverrideConfig>>;
};

export type UserProfileConfig = {
  flow: FlowMode;
  steps: Record<FlowStep, string>;
  fallbackRunner: string;
  lint?: UserLintToolConfig[];
  test?: string;
  sourceLayout?: UserSourceLayoutConfig;
  designLayout?: UserDesignLayoutConfig;
  storybook?: UserStorybookConfig;
  exec?: string | string[];
  toolRoot?: string;
  reviewCriteria?: string[];
  criteriaPreset?: "backend" | "frontend";
  context?: UserProfileContextConfig;
};

export type ResolvedProfileConfig = {
  flow: FlowMode;
  steps: Record<FlowStep, string>;
  fallbackRunner: string;
  lint: ResolvedLintToolConfig[];
  test: string;
  sourceLayout: SourceLayoutConfig;
  designLayout: DesignLayoutConfig;
  storybook?: StorybookConfig;
  exec: string[];
  toolRoot: string;
  reviewCriteria: string[];
  criteriaPreset: "backend" | "frontend" | undefined;
  context?: ProfileContextConfig;
};

export type HarnessUserConfig = {
  profiles?: Record<string, UserProfileConfig>;
  runners?: Record<string, RunnerConfig>;
  templates?: Record<string, string | null>;
};

export type ResolvedConfig = {
  profiles: Record<string, ResolvedProfileConfig>;
  runners: Record<string, RunnerConfig>;
  templates: Record<string, string | null>;
};

export type HarnessConfig = ResolvedConfig;

const PREFERRED_CONFIG_PATH = ".harness/config/harness.yml";
const CONFIG_FILENAMES = [PREFERRED_CONFIG_PATH];
const ALL_FLOW_STEPS = Object.values(FLOW_STEP);

export function loadConfig(projectRoot: string): ResolvedConfig {
  let userConfig: HarnessUserConfig = {};
  const configPath = findConfigPath(projectRoot);

  if (configPath) {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      userConfig = parsed as HarnessUserConfig;
    } else {
      throw new GuardError(
        `設定ファイルの形式が不正です: ${relativeConfigPath(projectRoot, configPath)}。YAML オブジェクトを記述してください。`,
      );
    }
  }

  // shape validation は入力 UX より runtime safety を優先する。
  // 曖昧な補完を避けて、flow 開始前に unsafe な設定を止める。
  validateUserConfigShape(userConfig);
  const migrated = requireProfiles(userConfig);
  const resolved: ResolvedConfig = {
    profiles: resolveProfiles(migrated.profiles ?? {}, projectRoot),
    runners: migrated.runners ?? { claude: { type: "claude" } },
    templates: migrated.templates ?? {},
  };

  validateConfig(resolved);
  return resolved;
}

function validateUserConfigShape(config: HarnessUserConfig): void {
  rejectLegacyTopLevelField(config, "flow", "profiles.<name>.flow");
  rejectLegacyTopLevelField(config, "steps", "profiles.<name>.steps");
  rejectLegacyTopLevelField(config, "fallbackRunner", "profiles.<name>.fallbackRunner");
  rejectLegacyTopLevelField(config, "claude", "profiles.<name>.context");

  if (config.profiles) {
    if (typeof config.profiles !== "object" || Array.isArray(config.profiles)) {
      throw new GuardError("profiles はオブジェクト形式で指定してください。");
    }
    for (const [name, profile] of Object.entries(config.profiles)) {
      if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
        throw new GuardError(`profile "${name}" はオブジェクト形式で指定してください（配列不可）。`);
      }

      rejectLegacyProfileField(profile, name, "claude", "context");

      if (profile.flow === undefined) {
        throw new GuardError(`profile "${name}".flow は必須です。full または light を指定してください。`);
      }
      if (profile.flow !== FLOW_MODE.FULL && profile.flow !== FLOW_MODE.LIGHT) {
        throw new GuardError(
          `profile "${name}".flow は "full" または "light" で指定してください。受け取った値: "${profile.flow}"`,
        );
      }
      if (profile.fallbackRunner === undefined || typeof profile.fallbackRunner !== "string" || profile.fallbackRunner.length === 0) {
        throw new GuardError(`profile "${name}".fallbackRunner は空でない文字列で指定してください。`);
      }
      validateStepRunnerMapShape(profile.steps, `profile "${name}".steps`);

      if (profile.lint !== undefined && !Array.isArray(profile.lint)) {
        throw new GuardError(
          `profile "${name}".lint は配列で指定してください。例: lint: [ruff, mypy]`,
        );
      }
      if (profile.lint !== undefined) {
        for (const t of profile.lint) {
          if (typeof t === "string") {
            if (t.length === 0) {
              throw new GuardError(`profile "${name}".lint の各要素は空でない文字列である必要があります。`);
            }
            continue;
          }
          if (!t || typeof t !== "object" || Array.isArray(t)) {
            throw new GuardError(
              `profile "${name}".lint の各要素は文字列または { name, args } 形式である必要があります。`,
            );
          }
          if (typeof t.name !== "string" || t.name.length === 0) {
            throw new GuardError(`profile "${name}".lint[].name は空でない文字列で指定してください。`);
          }
          if (t.args !== undefined) {
            if (!Array.isArray(t.args)) {
              throw new GuardError(`profile "${name}".lint[].args は文字列配列で指定してください。`);
            }
            for (const arg of t.args) {
              if (typeof arg !== "string" || arg.length === 0) {
                throw new GuardError(`profile "${name}".lint[].args の各要素は空でない文字列である必要があります。`);
              }
            }
          }
        }
      }
      if (profile.test !== undefined && typeof profile.test !== "string") {
        throw new GuardError(
          `profile "${name}".test は文字列で指定してください。例: test: pytest`,
        );
      }
      if (profile.reviewCriteria !== undefined) {
        if (!Array.isArray(profile.reviewCriteria)) {
          throw new GuardError(`profile "${name}".reviewCriteria は配列で指定してください。`);
        }
        for (const c of profile.reviewCriteria) {
          if (typeof c !== "string") {
            throw new GuardError(`profile "${name}".reviewCriteria の各要素は文字列である必要があります。`);
          }
        }
      }
      if (profile.sourceLayout !== undefined) {
        if (typeof profile.sourceLayout !== "object" || Array.isArray(profile.sourceLayout)) {
          throw new GuardError(`profile "${name}".sourceLayout はオブジェクト形式で指定してください。`);
        }
        const sl = profile.sourceLayout;
        if (sl.sourceDir !== undefined && typeof sl.sourceDir !== "string") {
          throw new GuardError(`profile "${name}".sourceLayout.sourceDir は文字列である必要があります。`);
        }
        if (sl.testDir !== undefined && typeof sl.testDir !== "string") {
          throw new GuardError(`profile "${name}".sourceLayout.testDir は文字列である必要があります。`);
        }
        if (sl.scopePattern !== undefined && typeof sl.scopePattern !== "string") {
          throw new GuardError(`profile "${name}".sourceLayout.scopePattern は文字列である必要があります。`);
        }
        if (sl.additionalAllowedPrefixes !== undefined) {
          if (!Array.isArray(sl.additionalAllowedPrefixes)) {
            throw new GuardError(`profile "${name}".sourceLayout.additionalAllowedPrefixes は配列で指定してください。`);
          }
          for (const p of sl.additionalAllowedPrefixes) {
            if (typeof p !== "string") {
              throw new GuardError(`profile "${name}".sourceLayout.additionalAllowedPrefixes の各要素は文字列である必要があります。`);
            }
          }
        }
      }
      if (profile.designLayout !== undefined) {
        if (typeof profile.designLayout !== "object" || Array.isArray(profile.designLayout)) {
          throw new GuardError(`profile "${name}".designLayout はオブジェクト形式で指定してください。`);
        }
        const dl = profile.designLayout;
        if (dl.specDir !== undefined && typeof dl.specDir !== "string") {
          throw new GuardError(`profile "${name}".designLayout.specDir は文字列である必要があります。`);
        }
        if (dl.testCaseDir !== undefined && typeof dl.testCaseDir !== "string") {
          throw new GuardError(`profile "${name}".designLayout.testCaseDir は文字列である必要があります。`);
        }
      }
      if (profile.storybook !== undefined) {
        if (typeof profile.storybook !== "object" || Array.isArray(profile.storybook)) {
          throw new GuardError(`profile "${name}".storybook はオブジェクト形式で指定してください。`);
        }
        const sb = profile.storybook;
        if (sb.renderCommand !== undefined) {
          validateStringArrayField(sb.renderCommand, `profile "${name}".storybook.renderCommand`);
        }
        if (sb.smokeCommand !== undefined) {
          validateStringArrayField(sb.smokeCommand, `profile "${name}".storybook.smokeCommand`);
        }
      }
      if (profile.criteriaPreset !== undefined) {
        if (profile.criteriaPreset !== "backend" && profile.criteriaPreset !== "frontend") {
          throw new GuardError(
            `profile "${name}".criteriaPreset は "backend" または "frontend" で指定してください。受け取った値: "${profile.criteriaPreset}"`,
          );
        }
      }
      if (profile.toolRoot !== undefined && typeof profile.toolRoot !== "string") {
        throw new GuardError(`profile "${name}".toolRoot は文字列である必要があります。`);
      }
      if (profile.context !== undefined) {
        validateProfileContextConfig(profile.context, `profile "${name}".context`);
      }
    }
  }

  if (config.templates !== undefined) {
    if (typeof config.templates !== "object" || Array.isArray(config.templates)) {
      throw new GuardError("templates はオブジェクト形式で指定してください。");
    }
  }

  if (config.runners !== undefined) {
    if (typeof config.runners !== "object" || Array.isArray(config.runners)) {
      throw new GuardError("runners はオブジェクト形式で指定してください。");
    }
    for (const [name, runner] of Object.entries(config.runners)) {
      if (!runner || typeof runner !== "object" || !("type" in runner)) {
        throw new GuardError(`runner "${name}" には type フィールドが必要です。`);
      }
      const r = runner as Record<string, unknown>;
      const validTypes = ["claude", "codex", "generic"];
      if (!validTypes.includes(r.type as string)) {
        throw new GuardError(
          `runner "${name}" の type "${r.type}" は不正です。利用可能: ${validTypes.join(", ")}`,
        );
      }
      if (r.type === "generic") {
        if (typeof r.command !== "string" || !r.command) {
          throw new GuardError(
            `runner "${name}" (type: generic) には command (文字列) が必要です。`,
          );
        }
        if (!Array.isArray(r.args)) {
          throw new GuardError(
            `runner "${name}" (type: generic) には args (文字列配列) が必要です。`,
          );
        }
        for (const arg of r.args as unknown[]) {
          if (typeof arg !== "string") {
            throw new GuardError(
              `runner "${name}" (type: generic) の args の各要素は文字列である必要があります。`,
            );
          }
        }
        if (r.promptFlag !== undefined && typeof r.promptFlag !== "string") {
          throw new GuardError(
            `runner "${name}" (type: generic) の promptFlag は文字列である必要があります。`,
          );
        }
      }
      if (r.timeoutMs !== undefined && (typeof r.timeoutMs !== "number" || r.timeoutMs <= 0)) {
        throw new GuardError(
          `runner "${name}" の timeoutMs は正の数値である必要があります。`,
        );
      }
      if (r.type === "claude" && r.model !== undefined && typeof r.model !== "string") {
        throw new GuardError(
          `runner "${name}" (type: claude) の model は文字列である必要があります。`,
        );
      }
      if (r.type === "codex" && r.sandbox !== undefined && typeof r.sandbox !== "string") {
        throw new GuardError(
          `runner "${name}" (type: codex) の sandbox は文字列である必要があります。`,
        );
      }
      if (r.type === "codex" && r.model !== undefined && typeof r.model !== "string") {
        throw new GuardError(
          `runner "${name}" (type: codex) の model は文字列である必要があります。`,
        );
      }
      if (
        r.type === "codex" &&
        r.approvalPolicy !== undefined &&
        !["untrusted", "on-failure", "on-request", "never"].includes(r.approvalPolicy as string)
      ) {
        throw new GuardError(
          `runner "${name}" (type: codex) の approvalPolicy は untrusted/on-failure/on-request/never のいずれかである必要があります。`,
        );
      }
      if (
        r.type === "codex" &&
        r.summary !== undefined &&
        !["auto", "brief", "detailed"].includes(r.summary as string)
      ) {
        throw new GuardError(
          `runner "${name}" (type: codex) の summary は auto/brief/detailed のいずれかである必要があります。`,
        );
      }
      if (
        r.type === "codex" &&
        r.effort !== undefined &&
        !["minimal", "low", "medium", "high"].includes(r.effort as string)
      ) {
        throw new GuardError(
          `runner "${name}" (type: codex) の effort は minimal/low/medium/high のいずれかである必要があります。`,
        );
      }
      if (
        r.type === "codex" &&
        r.personality !== undefined &&
        !["default", "strict", "balanced"].includes(r.personality as string)
      ) {
        throw new GuardError(
          `runner "${name}" (type: codex) の personality は default/strict/balanced のいずれかである必要があります。`,
        );
      }
    }
  }
}

function rejectLegacyTopLevelField(
  config: HarnessUserConfig,
  field: string,
  replacement: string,
): void {
  if (field in config) {
    throw new GuardError(`${field} はトップレベルでは使えません。${replacement} に移動してください。`);
  }
}

function rejectLegacyProfileField(
  profile: UserProfileConfig,
  profileName: string,
  field: string,
  replacement: string,
): void {
  if (field in profile) {
    throw new GuardError(`profile "${profileName}".${field} は廃止されました。profile "${profileName}".${replacement} を使ってください。`);
  }
}

function validateStepRunnerMapShape(
  value: unknown,
  field: string,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GuardError(`${field} はオブジェクト形式で指定してください。`);
  }

  const entries = value as Record<string, unknown>;
  const validStepKeys = new Set(ALL_FLOW_STEPS);

  for (const [step, runner] of Object.entries(entries)) {
    if (!validStepKeys.has(step as FlowStep)) {
      throw new GuardError(
        `${field} に未知の step "${step}" が指定されています。利用可能: ${ALL_FLOW_STEPS.join(", ")}`,
      );
    }
    if (typeof runner !== "string" || runner.length === 0) {
      throw new GuardError(`${field}.${step} は空でない文字列で指定してください。`);
    }
  }

  const missingSteps = ALL_FLOW_STEPS.filter((step) => !(step in entries));
  if (missingSteps.length > 0) {
    throw new GuardError(`${field} に不足している step があります: ${missingSteps.join(", ")}`);
  }
}

function validateProfileContextConfig(
  value: UserProfileContextConfig,
  field: string,
): void {
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new GuardError(`${field} はオブジェクト形式で指定してください。`);
  }
  if (value.defaultAgent !== undefined && typeof value.defaultAgent !== "string") {
    throw new GuardError(`${field}.defaultAgent は文字列で指定してください。`);
  }
  if (value.defaultSkills !== undefined) {
    validateStringArrayField(value.defaultSkills, `${field}.defaultSkills`);
  }
  if (value.defaultMcpConfigs !== undefined) {
    validateStringArrayField(value.defaultMcpConfigs, `${field}.defaultMcpConfigs`);
  }
  if (value.stepOverrides === undefined) return;
  if (typeof value.stepOverrides !== "object" || Array.isArray(value.stepOverrides)) {
    throw new GuardError(`${field}.stepOverrides はオブジェクト形式で指定してください。`);
  }

  const validStepKeys = new Set(ALL_FLOW_STEPS);
  for (const [step, override] of Object.entries(value.stepOverrides)) {
    if (!validStepKeys.has(step as FlowStep)) {
      throw new GuardError(
        `${field}.stepOverrides に未知の step "${step}" が指定されています。利用可能: ${ALL_FLOW_STEPS.join(", ")}`,
      );
    }
    if (!override || typeof override !== "object" || Array.isArray(override)) {
      throw new GuardError(`${field}.stepOverrides.${step} はオブジェクト形式で指定してください。`);
    }
    if (override.agent !== undefined && typeof override.agent !== "string") {
      throw new GuardError(`${field}.stepOverrides.${step}.agent は文字列で指定してください。`);
    }
    if (override.model !== undefined && typeof override.model !== "string") {
      throw new GuardError(`${field}.stepOverrides.${step}.model は文字列で指定してください。`);
    }
    if (override.skills !== undefined) {
      validateStringArrayField(override.skills, `${field}.stepOverrides.${step}.skills`);
    }
    if (override.mcpConfigs !== undefined) {
      validateStringArrayField(override.mcpConfigs, `${field}.stepOverrides.${step}.mcpConfigs`);
    }
  }
}

function requireProfiles(config: HarnessUserConfig): HarnessUserConfig {
  if (config.profiles && Object.keys(config.profiles).length > 0) {
    return config;
  }
  throw new GuardError(
    `profiles が定義されていません。${configLocationMessage()} に profiles を追加してください。\n\`./.harness/config/harness.example.yml\` と \`README.md\` を参照して \`.harness/config/harness.yml\` を作成してください。`,
  );
}

function resolveProfiles(
  profiles: Record<string, UserProfileConfig>,
  projectRoot: string,
): Record<string, ResolvedProfileConfig> {
  const result: Record<string, ResolvedProfileConfig> = {};
  for (const [name, user] of Object.entries(profiles)) {
    result[name] = resolveOneProfile(user, projectRoot);
  }
  return result;
}

function resolveOneProfile(
  user: UserProfileConfig,
  projectRoot: string,
): ResolvedProfileConfig {
  if (user.lint !== undefined) {
    for (const t of user.lint) {
      const toolName = typeof t === "string" ? t : t.name;
      if (!LINT_REGISTRY[toolName]) {
        throw new GuardError(
          `未知の lint ツール "${toolName}"。利用可能: ${Object.keys(LINT_REGISTRY).join(", ")}`,
        );
      }
    }
  }
  if (user.test !== undefined && !TEST_REGISTRY[user.test]) {
    throw new GuardError(
      `未知のテストランナー "${user.test}"。利用可能: ${Object.keys(TEST_REGISTRY).join(", ")}`,
    );
  }

  const hasExplicitLint = user.lint !== undefined;
  const hasExplicitTest = user.test !== undefined;

  let lint: ResolvedLintToolConfig[];
  let test: string;

  if (hasExplicitLint && hasExplicitTest) {
    lint = normalizeLintTools(user.lint!);
    test = user.test!;
  } else if (!hasExplicitLint && !hasExplicitTest) {
    lint = normalizeLintTools(["ruff", "mypy"]);
    test = "pytest";
  } else if (hasExplicitTest && !hasExplicitLint) {
    test = user.test!;
    const testRuntime = TEST_REGISTRY[test]?.runtime;
    if (testRuntime === "python") {
      lint = normalizeLintTools(["ruff", "mypy"]);
    } else {
      throw new GuardError(
        `lint が未指定ですが、test "${test}" (runtime: ${testRuntime}) に対するデフォルト lint は runtime が一致しません。lint を明示指定してください。`,
      );
    }
  } else {
    lint = normalizeLintTools(user.lint!);
    const lintRuntime = LINT_REGISTRY[lint[0]!.name]?.runtime;
    if (lintRuntime === "python") {
      test = "pytest";
    } else {
      throw new GuardError(
        `test が未指定ですが、lint の runtime (${lintRuntime}) に対するデフォルト test は runtime が一致しません。test を明示指定してください。`,
      );
    }
  }

  const rawToolRoot = user.toolRoot ?? ".";
  const toolRoot = resolve(projectRoot, rawToolRoot);
  const exec = normalizeExec(user.exec);
  const reviewCriteria = user.reviewCriteria ?? [];
  const storybook = user.storybook
    ? {
        renderCommand: [...(user.storybook.renderCommand ?? [])],
        smokeCommand: [...(user.storybook.smokeCommand ?? [])],
      }
    : undefined;
  const userLayout = user.sourceLayout;
  const sourceLayout: SourceLayoutConfig = {
    sourceDir: userLayout?.sourceDir ?? "backend/{{category}}",
    testDir: userLayout?.testDir ?? "backend/{{category}}/tests",
    scopePattern:
      userLayout?.scopePattern ??
      `${userLayout?.sourceDir ?? "backend/{{category}}"}/*`,
    additionalAllowedPrefixes:
      userLayout?.additionalAllowedPrefixes ?? [".harness/reviews/"],
  };
  const userDesignLayout = user.designLayout;
  const designLayout: DesignLayoutConfig = {
    specDir: userDesignLayout?.specDir ?? "docs/spec/{{category}}",
    testCaseDir: userDesignLayout?.testCaseDir ?? "tests/test-cases/{{category}}",
  };

  return {
    flow: user.flow,
    steps: cloneStepMap(user.steps),
    fallbackRunner: user.fallbackRunner,
    lint,
    test,
    sourceLayout,
    designLayout,
    storybook,
    exec,
    toolRoot,
    reviewCriteria,
    criteriaPreset: user.criteriaPreset,
    context: resolveProfileContextConfig(user.context),
  };
}

function normalizeLintTools(raw: UserLintToolConfig[]): ResolvedLintToolConfig[] {
  return raw.map((tool) => (
    typeof tool === "string"
      ? { name: tool, args: [] }
      : { name: tool.name, args: [...(tool.args ?? [])] }
  ));
}

function cloneStepMap(steps: Record<FlowStep, string>): Record<FlowStep, string> {
  return Object.fromEntries(
    ALL_FLOW_STEPS.map((step) => [step, steps[step]]),
  ) as Record<FlowStep, string>;
}

function normalizeExec(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) {
    for (const elem of raw) {
      if (typeof elem !== "string") {
        throw new HarnessError(
          `exec の要素は文字列である必要があります。不正な要素: ${JSON.stringify(elem)}`,
        );
      }
    }
    const result = raw as string[];
    for (const elem of result) {
      validateExecElement(elem);
    }
    return result;
  }
  if (typeof raw === "string") {
    validateExecElement(raw);
    return [raw];
  }
  throw new HarnessError(
    "exec は配列で指定してください。例: exec: [poetry, run]",
  );
}

function validateExecElement(elem: string): void {
  if (elem.length === 0) {
    throw new HarnessError("exec の要素に空文字列は指定できません。");
  }
  if (elem !== elem.trim()) {
    throw new HarnessError(
      `exec の要素に前後の空白を含む文字列は指定できません: "${elem}"`,
    );
  }
}

function validateConfig(config: ResolvedConfig): void {
  const profileNames = Object.keys(config.profiles);
  if (profileNames.length === 0) {
    throw new GuardError(
      `profiles が定義されていません。${configLocationMessage()} に profiles を追加してください。`,
    );
  }

  const runnerNames = Object.keys(config.runners);
  if (runnerNames.length === 0) {
    throw new GuardError("runners が定義されていません。");
  }

  for (const [name, profile] of Object.entries(config.profiles)) {
    validateProfile(name, profile, runnerNames);
  }
}

function validateProfile(
  name: string,
  profile: ResolvedProfileConfig,
  runnerNames: string[],
): void {
  if (profile.lint.length === 0) {
    throw new GuardError(`profile "${name}": lint ツールが指定されていません。`);
  }

  for (const tool of profile.lint) {
    if (!LINT_REGISTRY[tool.name]) {
      throw new GuardError(
        `profile "${name}": 未知の lint ツール "${tool.name}"。利用可能: ${Object.keys(LINT_REGISTRY).join(", ")}`,
      );
    }
  }

  const runtimes = new Set(profile.lint.map((t) => LINT_REGISTRY[t.name].runtime));
  if (runtimes.size > 1) {
    throw new GuardError(
      `profile "${name}": 異なる runtime の lint ツールを混在させることはできません（検出: ${[...runtimes].join(", ")}）。profile を分けてください。`,
    );
  }

  if (!TEST_REGISTRY[profile.test]) {
    throw new GuardError(
      `profile "${name}": 未知のテストランナー "${profile.test}"。利用可能: ${Object.keys(TEST_REGISTRY).join(", ")}`,
    );
  }

  const lintRuntime = [...runtimes][0];
  const testRuntime = TEST_REGISTRY[profile.test].runtime;
  if (lintRuntime && testRuntime !== lintRuntime) {
    throw new GuardError(
      `profile "${name}": lint runtime (${lintRuntime}) と test runtime (${testRuntime}) が一致しません。`,
    );
  }

  validatePathTemplate(
    `profile "${name}".sourceLayout.sourceDir`,
    profile.sourceLayout.sourceDir,
  );
  validatePathTemplate(
    `profile "${name}".sourceLayout.testDir`,
    profile.sourceLayout.testDir,
  );
  validatePathTemplate(
    `profile "${name}".designLayout.specDir`,
    profile.designLayout.specDir,
  );
  validatePathTemplate(
    `profile "${name}".designLayout.testCaseDir`,
    profile.designLayout.testCaseDir,
  );
  validateScopePattern(
    `profile "${name}".sourceLayout.scopePattern`,
    profile.sourceLayout.scopePattern,
  );
  for (const prefix of profile.sourceLayout.additionalAllowedPrefixes) {
    validatePathTemplate(
      `profile "${name}".sourceLayout.additionalAllowedPrefixes`,
      prefix,
    );
  }
  if (profile.storybook) {
    validateResolvedStringArray(profile.storybook.renderCommand, `profile "${name}".storybook.renderCommand`);
    validateResolvedStringArray(profile.storybook.smokeCommand, `profile "${name}".storybook.smokeCommand`);
  }

  if (!runnerNames.includes(profile.fallbackRunner)) {
    throw new GuardError(
      `profile "${name}".fallbackRunner "${profile.fallbackRunner}" が runners に存在しません。利用可能: ${runnerNames.join(", ")}`,
    );
  }

  for (const step of ALL_FLOW_STEPS) {
    const runner = profile.steps[step];
    if (!runnerNames.includes(runner)) {
      throw new GuardError(
        `profile "${name}".steps.${step} に指定された runner "${runner}" が runners に存在しません。利用可能: ${runnerNames.join(", ")}`,
      );
    }
  }
}

function validateStringArrayField(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new GuardError(`${field} は空でない文字列配列で指定してください。`);
  }
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      throw new GuardError(`${field} の各要素は空でない文字列である必要があります。`);
    }
  }
}

function resolveProfileContextConfig(
  user: UserProfileContextConfig | undefined,
): ProfileContextConfig | undefined {
  if (!user) return undefined;

  const stepOverrides: Partial<Record<FlowStep, StepContextOverrideConfig>> = {};
  for (const [step, override] of Object.entries(user.stepOverrides ?? {})) {
    stepOverrides[step as FlowStep] = {
      agent: override?.agent,
      model: override?.model,
      skills: [...(override?.skills ?? [])],
      mcpConfigs: [...(override?.mcpConfigs ?? [])],
    };
  }

  return {
    defaultAgent: user.defaultAgent,
    defaultSkills: [...(user.defaultSkills ?? [])],
    defaultMcpConfigs: [...(user.defaultMcpConfigs ?? [])],
    stepOverrides,
  };
}

function validateResolvedStringArray(value: string[], field: string): void {
  if (value.length === 0) {
    throw new GuardError(`${field} は空配列にできません。`);
  }
  for (const item of value) {
    if (item.length === 0) {
      throw new GuardError(`${field} の各要素は空文字列にできません。`);
    }
  }
}

function validatePathTemplate(field: string, value: string): void {
  if (value.startsWith("/")) {
    throw new GuardError(`${field}: 絶対パスは指定できません: "${value}"`);
  }
  if (value.includes("..")) {
    throw new GuardError(
      `${field}: ".." を含むパスは指定できません: "${value}"`,
    );
  }
  const withoutPlaceholders = value
    .replaceAll("{{category}}", "")
    .replaceAll("{{name}}", "");
  if (/\{\{/.test(withoutPlaceholders)) {
    throw new GuardError(
      `${field}: 未知のプレースホルダが含まれています: "${value}"。許可: {{category}}, {{name}}`,
    );
  }
  if (/[,)()*?\\]/.test(withoutPlaceholders)) {
    throw new GuardError(
      `${field}: 特殊文字（, ) ( * ? \\）は許可されていません: "${value}"`,
    );
  }
}

function validateScopePattern(field: string, value: string): void {
  const trimmed = value.replace(/\/\*{1,2}$/, "");
  validatePathTemplate(field, trimmed);
  if (!value.endsWith("/*") && !value.endsWith("/**")) {
    throw new GuardError(
      `${field}: scopePattern の末尾は "/*" または "/**" である必要があります: "${value}"`,
    );
  }
}

export function inferProfile(config: ResolvedConfig): string {
  const names = Object.keys(config.profiles);
  if (names.length === 1) return names[0];
  throw new GuardError(
    `複数の profile があります（${names.join(", ")}）。plan ファイルの frontmatter で profile を指定してください。`,
  );
}

export function resolveProfile(
  config: ResolvedConfig,
  profileName: string,
): ResolvedProfileConfig {
  const profile = config.profiles[profileName];
  if (!profile) {
    throw new GuardError(
      `profile "${profileName}" が見つかりません。${configLocationMessage()} の profiles を確認してください。利用可能: ${Object.keys(config.profiles).join(", ")}`,
    );
  }
  return profile;
}

function findConfigPath(projectRoot: string): string | null {
  for (const name of CONFIG_FILENAMES) {
    const configPath = join(projectRoot, name);
    if (existsSync(configPath)) {
      return configPath;
    }
  }
  return null;
}

function relativeConfigPath(projectRoot: string, filePath: string): string {
  const relativePath = relative(resolve(projectRoot), resolve(filePath));
  return relativePath || filePath;
}

function configLocationMessage(): string {
  return PREFERRED_CONFIG_PATH;
}
