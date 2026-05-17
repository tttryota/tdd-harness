import type { ResolvedProfileConfig } from "../../infrastructure/config/config.ts";
import type { RunnerRegistry } from "../../infrastructure/runners/runner-registry.ts";
import type { LintAdapter } from "../../infrastructure/tooling/tool-adapter.ts";
import type { Logger } from "./logger.ts";
import type { ToolExecutor } from "./tool-executor.ts";
import { DriftGuard } from "../review/drift-guard.ts";
import { LintGuard } from "../review/lint-guard.ts";
import { ReviewOrchestrator } from "../review/review-orchestrator.ts";

type BaseFlowRuntimeContext = {
  taskName: string;
  projectRoot: string;
  profile: ResolvedProfileConfig;
  registry: RunnerRegistry;
  lintAdapters: LintAdapter[];
  toolExecutor: ToolExecutor;
};

export type PageRuntimeContext = BaseFlowRuntimeContext;

export type ComponentRuntimeContext = BaseFlowRuntimeContext;

export type ImplRuntimeContext = BaseFlowRuntimeContext & {
  resume?: boolean;
  codexAvailable: boolean;
};

export type PageFlowRuntime = {
  logger: Logger;
  lintGuard: LintGuard;
  reviewOrchestrator: ReviewOrchestrator;
};

export type ComponentFlowRuntime = {
  logger: Logger;
  lintGuard: LintGuard;
  reviewOrchestrator: ReviewOrchestrator;
};

export type ImplFlowRuntime = {
  logger: Logger;
  lintGuard: LintGuard;
  reviewOrchestrator: ReviewOrchestrator;
  driftGuard: DriftGuard;
};

export type FlowRuntimeFactory = {
  createPageRuntime(context: PageRuntimeContext): PageFlowRuntime;
  createComponentRuntime(context: ComponentRuntimeContext): ComponentFlowRuntime;
  createImplRuntime(context: ImplRuntimeContext): ImplFlowRuntime;
};
