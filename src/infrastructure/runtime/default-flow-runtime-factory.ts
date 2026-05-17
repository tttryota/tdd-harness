import { join } from "node:path";
import type { FlowRuntimeFactory, ComponentRuntimeContext, ComponentFlowRuntime, ImplRuntimeContext, ImplFlowRuntime, PageRuntimeContext, PageFlowRuntime } from "../../application/ports/flow-runtime-factory.ts";
import { HarnessLogger, DEFAULT_LOG_BASE_DIR } from "../logging/logger.ts";
import { DriftGuard } from "../../application/review/drift-guard.ts";
import { LintGuard } from "../../application/review/lint-guard.ts";
import { ReviewOrchestrator } from "../../application/review/review-orchestrator.ts";

export class DefaultFlowRuntimeFactory implements FlowRuntimeFactory {
  createPageRuntime(context: PageRuntimeContext): PageFlowRuntime {
    const logger = new HarnessLogger(context.taskName, {
      baseDir: join(context.projectRoot, DEFAULT_LOG_BASE_DIR),
    });
    const lintGuard = new LintGuard(logger, context.lintAdapters, {
      toolRoot: context.profile.toolRoot,
      execOverride: context.profile.exec,
    }, context.toolExecutor);
    const reviewOrchestrator = new ReviewOrchestrator(
      logger,
      lintGuard,
      context.projectRoot,
      context.registry,
      context.profile,
    );
    return { logger, lintGuard, reviewOrchestrator };
  }

  createComponentRuntime(context: ComponentRuntimeContext): ComponentFlowRuntime {
    const logger = new HarnessLogger(context.taskName, {
      baseDir: join(context.projectRoot, DEFAULT_LOG_BASE_DIR),
    });
    const lintGuard = new LintGuard(logger, context.lintAdapters, {
      toolRoot: context.profile.toolRoot,
      execOverride: context.profile.exec,
    }, context.toolExecutor);
    const reviewOrchestrator = new ReviewOrchestrator(
      logger,
      lintGuard,
      context.projectRoot,
      context.registry,
      context.profile,
    );
    return { logger, lintGuard, reviewOrchestrator };
  }

  createImplRuntime(context: ImplRuntimeContext): ImplFlowRuntime {
    const logger = new HarnessLogger(context.taskName, {
      baseDir: join(context.projectRoot, DEFAULT_LOG_BASE_DIR),
      resume: context.resume,
    });
    const lintGuard = new LintGuard(logger, context.lintAdapters, {
      toolRoot: context.profile.toolRoot,
      execOverride: context.profile.exec,
    }, context.toolExecutor);
    const reviewOrchestrator = new ReviewOrchestrator(
      logger,
      lintGuard,
      context.projectRoot,
      context.registry,
      context.profile,
    );
    const driftGuard = new DriftGuard(logger, {
      codexAvailable: context.codexAvailable,
    });
    return { logger, lintGuard, reviewOrchestrator, driftGuard };
  }
}
