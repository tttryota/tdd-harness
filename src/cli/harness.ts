#!/usr/bin/env node
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HarnessLogger, DEFAULT_LOG_BASE_DIR } from "../infrastructure/logging/logger.ts";
import { HarnessError } from "../domain/model/types.ts";
import { DesignFlow } from "../application/flows/design-flow.ts";
import { ComponentFlow } from "../application/flows/component-flow.ts";
import { ImplFlow } from "../application/flows/impl-flow.ts";
import { PageFlow } from "../application/flows/page-flow.ts";
import { loadConfig, inferProfile, resolveProfile } from "../infrastructure/config/config.ts";
import { createRunnerRegistry } from "../infrastructure/runners/runner-registry.ts";
import { interactiveRunnerAssignment } from "./interactive.ts";
import { parsePlan } from "../domain/services/plan-parser.ts";
import { resolveLintAdapter, resolveTestAdapter } from "../infrastructure/tooling/tool-adapter.ts";
import { FsProjectBoundary } from "../infrastructure/project/fs-project-boundary.ts";
import { LauncherToolExecutor } from "../infrastructure/process/launcher-tool-executor.ts";
import { DefaultFlowRuntimeFactory } from "../infrastructure/runtime/default-flow-runtime-factory.ts";
import type {
  BaseAdapter,
  LintAdapter,
  TestAdapter,
} from "../infrastructure/tooling/tool-adapter.ts";
import type { FlowMode, FlowStep } from "../domain/model/steps.ts";
import { renderBenchmarkSummary } from "../application/diagnostics/benchmark-summary.ts";
import { renderBenchmarkDiagnose } from "../application/diagnostics/benchmark-diagnose.ts";
import { syncBundledSkills } from "../infrastructure/skills/sync-skills.ts";
import type { HarnessConfig, ResolvedProfileConfig } from "../infrastructure/config/config.ts";
import type { RunnerRegistry } from "../infrastructure/runners/runner-registry.ts";
import type { TaskPlan } from "../domain/model/types.ts";
import type { ProjectBoundary } from "../application/ports/project-boundary.ts";
import type { FlowRuntimeFactory } from "../application/ports/flow-runtime-factory.ts";
import type { Logger } from "../application/ports/logger.ts";
import type { ToolExecutor } from "../application/ports/tool-executor.ts";

export const LOCAL_CLI_NAME = "./.harness/bin/harness";

export type CliRuntime = {
  cwd: () => string;
  isTTY: boolean;
  writeStdout: (line: string) => void;
  writeStderr: (line: string) => void;
};

type FlowResources = {
  boundary: ProjectBoundary;
  registry: RunnerRegistry;
  profile: ResolvedProfileConfig;
  lintAdapters: LintAdapter[];
  testAdapter: TestAdapter;
  toolExecutor: ToolExecutor;
  runtimeFactory: FlowRuntimeFactory;
  effectiveFlow: FlowMode;
  overrides?: Partial<Record<FlowStep, string>>;
};

export type CliDeps = {
  loadConfig: typeof loadConfig;
  inferProfile: typeof inferProfile;
  resolveProfile: typeof resolveProfile;
  parsePlan: typeof parsePlan;
  resolveLintAdapter: typeof resolveLintAdapter;
  resolveTestAdapter: typeof resolveTestAdapter;
  createRunnerRegistry: typeof createRunnerRegistry;
  interactiveRunnerAssignment: typeof interactiveRunnerAssignment;
  createProjectBoundary: (projectRoot: string, profile: ResolvedProfileConfig, adapters: BaseAdapter[]) => ProjectBoundary;
  createToolExecutor: () => ToolExecutor;
  createFlowRuntimeFactory: () => FlowRuntimeFactory;
  createImplFlow: (
    boundary: ProjectBoundary,
    registry: RunnerRegistry,
    profile: ResolvedProfileConfig,
    testAdapter: TestAdapter,
    lintAdapters: LintAdapter[],
    runtimeFactory: FlowRuntimeFactory,
    toolExecutor: ToolExecutor,
  ) => ImplFlow;
  createPageFlow: (
    boundary: ProjectBoundary,
    registry: RunnerRegistry,
    profile: ResolvedProfileConfig,
    testAdapter: TestAdapter,
    lintAdapters: LintAdapter[],
    runtimeFactory: FlowRuntimeFactory,
    toolExecutor: ToolExecutor,
  ) => PageFlow;
  createComponentFlow: (
    boundary: ProjectBoundary,
    registry: RunnerRegistry,
    profile: ResolvedProfileConfig,
    testAdapter: TestAdapter,
    lintAdapters: LintAdapter[],
    runtimeFactory: FlowRuntimeFactory,
    toolExecutor: ToolExecutor,
  ) => ComponentFlow;
  createDesignFlow: (
    boundary: ProjectBoundary,
    registry: RunnerRegistry,
    profile?: ResolvedProfileConfig,
  ) => DesignFlow;
  createLogger: (featureName: string, projectRoot: string) => Logger;
  renderBenchmarkSummary: typeof renderBenchmarkSummary;
  renderBenchmarkDiagnose: typeof renderBenchmarkDiagnose;
  syncBundledSkills: typeof syncBundledSkills;
};

const defaultRuntime: CliRuntime = {
  cwd: () => process.cwd(),
  isTTY: Boolean(process.stdin.isTTY),
  writeStdout: (line) => console.log(line),
  writeStderr: (line) => console.error(line),
};

const defaultDeps: CliDeps = {
  loadConfig,
  inferProfile,
  resolveProfile,
  parsePlan,
  resolveLintAdapter,
  resolveTestAdapter,
  createRunnerRegistry,
  interactiveRunnerAssignment,
  createProjectBoundary(projectRoot, profile, adapters) {
    const extensions = [...new Set(adapters.flatMap((adapter) => [...adapter.fileExtensions]))];
    const excludeDirs = [...new Set(adapters.flatMap((adapter) => [...adapter.excludeDirs]))];
    return new FsProjectBoundary(projectRoot, {
      sourceDir: profile.sourceLayout.sourceDir,
      testDir: profile.sourceLayout.testDir,
      scopePattern: profile.sourceLayout.scopePattern,
      additionalAllowedPrefixes: [...profile.sourceLayout.additionalAllowedPrefixes],
    }, extensions, excludeDirs);
  },
  createToolExecutor: () => new LauncherToolExecutor(),
  createFlowRuntimeFactory: () => new DefaultFlowRuntimeFactory(),
  createImplFlow: (boundary, registry, profile, testAdapter, lintAdapters, runtimeFactory, toolExecutor) =>
    new ImplFlow(boundary, registry, profile, testAdapter, lintAdapters, runtimeFactory, toolExecutor),
  createPageFlow: (boundary, registry, profile, testAdapter, lintAdapters, runtimeFactory, toolExecutor) =>
    new PageFlow(boundary, registry, profile, testAdapter, lintAdapters, runtimeFactory, toolExecutor),
  createComponentFlow: (boundary, registry, profile, testAdapter, lintAdapters, runtimeFactory, toolExecutor) =>
    new ComponentFlow(boundary, registry, profile, testAdapter, lintAdapters, runtimeFactory, toolExecutor),
  createDesignFlow: (boundary, registry, profile) => new DesignFlow(boundary, registry, profile),
  createLogger: (featureName, projectRoot) =>
    new HarnessLogger(`design_${featureName}`, { baseDir: join(projectRoot, DEFAULT_LOG_BASE_DIR) }),
  renderBenchmarkSummary,
  renderBenchmarkDiagnose,
  syncBundledSkills,
};

export function usageLines(cliName = LOCAL_CLI_NAME): string[] {
  return [
    "Usage:",
    `  ${cliName} impl <plan-file> [--resume] [--flow full|light] [--no-interactive]`,
    `  ${cliName} component <plan-file> [--flow full|light] [--no-interactive]`,
    `  ${cliName} page <plan-file> [--flow full|light] [--no-interactive]`,
    `  ${cliName} design [--profile <name>] <feature-name> "<requirements>"`,
    `  ${cliName} benchmark-summary <log-dir> [<log-dir>]`,
    `  ${cliName} benchmark-diagnose <log-dir> [<log-dir>]`,
    `  ${cliName} sync-skills`,
  ];
}

function writeLines(runtime: CliRuntime, lines: string[], target: "stdout" | "stderr" = "stdout"): void {
  const writer = target === "stdout" ? runtime.writeStdout : runtime.writeStderr;
  for (const line of lines) {
    writer(line);
  }
}

function requireValue(value: string | undefined, message: string): string {
  if (!value) {
    throw new HarnessError(message);
  }
  return value;
}

function parseFlowArg(args: string[]): FlowMode | undefined {
  const flowFlagIndex = args.indexOf("--flow");
  return flowFlagIndex !== -1 ? args[flowFlagIndex + 1] as FlowMode | undefined : undefined;
}

async function resolveFlowResources(
  projectRoot: string,
  config: HarnessConfig,
  planPath: string,
  args: string[],
  runtime: CliRuntime,
  deps: CliDeps,
  options?: { resume?: boolean },
): Promise<FlowResources & { plan: TaskPlan }> {
  const plan = deps.parsePlan(projectRoot, planPath);
  const profileName = plan.profile ?? deps.inferProfile(config);
  const profile = deps.resolveProfile(config, profileName);
  const effectiveFlow = parseFlowArg(args) ?? profile.flow;
  const lintAdapters = profile.lint.map((tool) => deps.resolveLintAdapter(tool.name, tool.args));
  const testAdapter = deps.resolveTestAdapter(profile.test);
  const allAdapters: BaseAdapter[] = [...lintAdapters, testAdapter];
  const boundary = deps.createProjectBoundary(projectRoot, profile, allAdapters);
  const toolExecutor = deps.createToolExecutor();
  const runtimeFactory = deps.createFlowRuntimeFactory();

  let overrides: Partial<Record<FlowStep, string>> | undefined;
  const noInteractive = args.includes("--no-interactive");
  if (!noInteractive && !options?.resume && runtime.isTTY) {
    overrides = await deps.interactiveRunnerAssignment(
      Object.keys(config.runners),
      profile.steps,
      effectiveFlow,
    ) ?? undefined;
  }

  const registry = deps.createRunnerRegistry(
    config,
    projectRoot,
    profile,
    overrides,
    effectiveFlow,
  );

  return { plan, boundary, registry, profile, lintAdapters, testAdapter, toolExecutor, runtimeFactory, effectiveFlow, overrides };
}

async function runImplCommand(
  projectRoot: string,
  config: HarnessConfig,
  args: string[],
  runtime: CliRuntime,
  deps: CliDeps,
): Promise<number> {
  const planPath = requireValue(args[1], "Error: plan file path required");
  const resume = args.includes("--resume");
  const resources = await resolveFlowResources(projectRoot, config, planPath, args, runtime, deps, { resume });
  const implFlow = deps.createImplFlow(
    resources.boundary,
    resources.registry,
    resources.profile,
    resources.testAdapter,
    resources.lintAdapters,
    resources.runtimeFactory,
    resources.toolExecutor,
  );
  await implFlow.run(planPath, { resume, plan: resources.plan });
  return 0;
}

async function runPageCommand(
  projectRoot: string,
  config: HarnessConfig,
  args: string[],
  runtime: CliRuntime,
  deps: CliDeps,
): Promise<number> {
  const planPath = requireValue(args[1], "Error: plan file path required");
  const resources = await resolveFlowResources(projectRoot, config, planPath, args, runtime, deps);
  const pageFlow = deps.createPageFlow(
    resources.boundary,
    resources.registry,
    resources.profile,
    resources.testAdapter,
    resources.lintAdapters,
    resources.runtimeFactory,
    resources.toolExecutor,
  );
  await pageFlow.run(planPath, { plan: resources.plan });
  return 0;
}

async function runComponentCommand(
  projectRoot: string,
  config: HarnessConfig,
  args: string[],
  runtime: CliRuntime,
  deps: CliDeps,
): Promise<number> {
  const planPath = requireValue(args[1], "Error: plan file path required");
  const resources = await resolveFlowResources(projectRoot, config, planPath, args, runtime, deps);
  const componentFlow = deps.createComponentFlow(
    resources.boundary,
    resources.registry,
    resources.profile,
    resources.testAdapter,
    resources.lintAdapters,
    resources.runtimeFactory,
    resources.toolExecutor,
  );
  await componentFlow.run(planPath, { plan: resources.plan });
  return 0;
}

async function runDesignCommand(
  projectRoot: string,
  config: HarnessConfig,
  args: string[],
  deps: CliDeps,
): Promise<number> {
  const { featureName, requirements, profileName } = parseDesignArgs(args.slice(1));
  const boundary = new FsProjectBoundary(projectRoot);
  const profile = deps.resolveProfile(config, profileName ?? inferDesignProfile(config));
  const registry = deps.createRunnerRegistry(config, projectRoot, profile);
  const logger = deps.createLogger(featureName, projectRoot);
  const flow = deps.createDesignFlow(boundary, registry, profile);
  await flow.run(featureName, requirements, logger);
  return 0;
}

function parseDesignArgs(args: string[]): {
  featureName: string;
  requirements: string;
  profileName?: string;
} {
  const positionals: string[] = [];
  let profileName: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--profile") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new HarnessError("Error: --profile requires a profile name");
      }
      if (looksLikeFeatureName(value) && args[index + 2] !== undefined) {
        throw new HarnessError("Error: --profile requires a profile name");
      }
      profileName = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new HarnessError(`Error: unknown flag for design: ${arg}`);
    }
    positionals.push(arg);
  }

  if (positionals.length < 2) {
    throw new HarnessError("Error: feature name and requirements required");
  }
  if (positionals.length > 2) {
    throw new HarnessError("Error: design accepts exactly one feature name and one requirements string");
  }

  return {
    featureName: positionals[0]!,
    requirements: positionals[1]!,
    profileName,
  };
}

function looksLikeFeatureName(value: string): boolean {
  const parts = value.split("/");
  return parts.length === 2 && parts.every((part) => part.length > 0);
}

function inferDesignProfile(config: HarnessConfig): string {
  const names = Object.keys(config.profiles);
  if (names.length === 1) return names[0]!;
  throw new HarnessError(
    `複数の profile があります（${names.join(", ")}）。design コマンドでは --profile <name> を追加してください。`,
  );
}

function runBenchmarkSummaryCommand(args: string[], runtime: CliRuntime, deps: CliDeps): number {
  const logDirs = args.slice(1);
  if (logDirs.length === 0 || logDirs.length > 2) {
    throw new HarnessError("Error: benchmark-summary requires one or two log directories");
  }
  runtime.writeStdout(deps.renderBenchmarkSummary(logDirs));
  return 0;
}

function runBenchmarkDiagnoseCommand(
  projectRoot: string,
  args: string[],
  runtime: CliRuntime,
  deps: CliDeps,
): number {
  const logDirs = args.slice(1);
  if (logDirs.length === 0 || logDirs.length > 2) {
    throw new HarnessError("Error: benchmark-diagnose requires one or two log directories");
  }
  runtime.writeStdout(deps.renderBenchmarkDiagnose(logDirs, projectRoot));
  return 0;
}

function runSyncSkillsCommand(projectRoot: string, runtime: CliRuntime, deps: CliDeps): number {
  const skills = deps.syncBundledSkills(projectRoot);
  runtime.writeStdout(`Synced harness skills to .codex/skills and .claude/skills: ${skills.join(", ")}`);
  return 0;
}

export async function runCli(
  args: string[],
  runtime: CliRuntime = defaultRuntime,
  deps: CliDeps = defaultDeps,
): Promise<number> {
  const command = args[0];
  if (!command) {
    writeLines(runtime, usageLines());
    return 1;
  }

  const projectRoot = runtime.cwd();
  if (command === "sync-skills") {
    return runSyncSkillsCommand(projectRoot, runtime, deps);
  }
  const config = deps.loadConfig(projectRoot);

  switch (command) {
    case "impl":
      return runImplCommand(projectRoot, config, args, runtime, deps);
    case "page":
      return runPageCommand(projectRoot, config, args, runtime, deps);
    case "component":
      return runComponentCommand(projectRoot, config, args, runtime, deps);
    case "design":
      return runDesignCommand(projectRoot, config, args, deps);
    case "benchmark-summary":
      return runBenchmarkSummaryCommand(args, runtime, deps);
    case "benchmark-diagnose":
      return runBenchmarkDiagnoseCommand(projectRoot, args, runtime, deps);
    default:
      throw new HarnessError(`Unknown command: ${command}`);
  }
}

export async function main(
  args = process.argv.slice(2),
  runtime: CliRuntime = defaultRuntime,
  deps: CliDeps = defaultDeps,
): Promise<number> {
  try {
    return await runCli(args, runtime, deps);
  } catch (error: unknown) {
    if (error instanceof HarnessError) {
      runtime.writeStderr(`[${error.name}] ${error.message}`);
    } else {
      runtime.writeStderr(`Unexpected error: ${String(error)}`);
    }
    return 1;
  }
}

const isMainModule = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMainModule) {
  const exitCode = await main();
  process.exit(exitCode);
}
