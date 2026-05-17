import type { TaskPlan } from "../../domain/model/types.ts";

export type ProjectBoundaryLayout = {
  sourceDir: string;
  testDir: string;
  scopePattern: string;
  additionalAllowedPrefixes: string[];
};

export type ProjectBoundary = {
  getProjectRoot(): string;
  validateScope(scope: string): void;
  extractCategory(featureName: string): string;
  extractName(featureName: string): string;
  assertWithinProject(fullPath: string): void;
  implementationGuard(plan: TaskPlan): void;
  readFrontmatter(filePath: string): Record<string, string>;
  findSourceFiles(scope: string): Promise<string[]>;
  findImplementationFiles(scope: string): Promise<string[]>;
  findTestFiles(scope: string): Promise<string[]>;
  findMisplacedTestFiles(scope: string): Promise<string[]>;
  testPathForScope(scope: string): string;
  scopeAllowedTools(scope: string): string[];
  implAllowedTools(scope: string): string[];
  testAllowedTools(scope: string): string[];
  stageFiles(scope: string): Promise<void>;
  verifyChangedFilesWithinScope(scope: string): Promise<void>;
  getCurrentCommitHash(): Promise<string>;
  countDiffLines(): Promise<number>;
  getFileDiff(files: string[]): Promise<string>;
};
