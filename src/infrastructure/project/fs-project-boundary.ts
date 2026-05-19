import { existsSync, realpathSync, lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, dirname, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectBoundary, ProjectBoundaryLayout } from "../../application/ports/project-boundary.ts";
import { GuardError } from "../../domain/model/types.ts";
import type { TaskPlan } from "../../domain/model/types.ts";

const execFileAsync = promisify(execFile);

const LOCAL_CMD_TIMEOUT_MS = 5 * 60 * 1000;

export class FsProjectBoundary implements ProjectBoundary {
  private projectRoot: string;
  private realRoot: string;
  private sourceLayout: ProjectBoundaryLayout;
  private fileExtensions: readonly string[];
  private excludeDirs: readonly string[];
  private initialChangedFileDigests: Map<string, string | null> | null = null;

  constructor(
    projectRoot: string,
    sourceLayout?: ProjectBoundaryLayout,
    fileExtensions?: readonly string[],
    excludeDirs?: readonly string[],
  ) {
    this.projectRoot = resolve(projectRoot);
    this.realRoot = realpathSync(this.projectRoot);
    this.sourceLayout = sourceLayout ?? {
      sourceDir: "backend/{{category}}",
      testDir: "backend/{{category}}/tests",
      scopePattern: "backend/{{category}}/*",
      additionalAllowedPrefixes: [".harness/reviews/"],
    };
    this.fileExtensions = fileExtensions ?? ["py"];
    this.excludeDirs = excludeDirs ?? ["__pycache__", ".venv"];
  }

  getProjectRoot(): string {
    return this.projectRoot;
  }

  private resolvePattern(pattern: string, scope: string): string {
    const category = this.extractCategory(scope);
    const name = this.extractName(scope);
    return pattern.replaceAll("{{category}}", category).replaceAll("{{name}}", name);
  }

  validateScope(scope: string): void {
    const parts = scope.split("/");
    if (parts.length !== 2) {
      throw new GuardError(
        `scope は "カテゴリ/名前" の2要素形式で指定してください（例: ingestion/chunk-splitter）。受け取った値: "${scope}"（${parts.length}要素）`,
      );
    }
    for (const segment of parts) {
      this.validatePathSegment(segment);
    }
  }

  extractCategory(featureName: string): string {
    const parts = featureName.split("/");
    if (parts.length !== 2) {
      throw new GuardError(
        `featureName は "カテゴリ/名前" の2要素形式で指定してください（例: ingestion/chunk-splitter）。受け取った値: "${featureName}"（${parts.length}要素）`,
      );
    }
    this.validatePathSegment(parts[0]);
    return parts[0];
  }

  extractName(featureName: string): string {
    const parts = featureName.split("/");
    if (parts.length !== 2) {
      throw new GuardError(
        `featureName は "カテゴリ/名前" の2要素形式で指定してください（例: ingestion/chunk-splitter）。受け取った値: "${featureName}"（${parts.length}要素）`,
      );
    }
    this.validatePathSegment(parts[1]);
    return parts[1];
  }

  assertWithinProject(fullPath: string): void {
    const realPath = existsSync(fullPath)
      ? realpathSync(fullPath)
      : this.realpathNearestAncestor(fullPath);
    const boundary = this.realRoot.endsWith("/") ? this.realRoot : this.realRoot + "/";
    if (!realPath.startsWith(boundary) && realPath !== this.realRoot) {
      throw new GuardError(
        `パスがプロジェクトルート外を参照しています: ${fullPath} (実体: ${realPath})`,
      );
    }
  }

  private realpathNearestAncestor(targetPath: string): string {
    let current = targetPath;
    while (current !== dirname(current)) {
      current = dirname(current);
      if (existsSync(current)) {
        const realAncestor = realpathSync(current);
        const remainder = targetPath.slice(current.length);
        return realAncestor + remainder;
      }
    }
    return targetPath;
  }

  private validatePathSegment(segment: string): void {
    if (segment.includes("..") || segment.startsWith("/") || segment === "") {
      throw new GuardError(`不正なパスセグメント: "${segment}"。パストラバーサルは許可されていません。`);
    }
    if (/[,)()*?\\]/.test(segment)) {
      throw new GuardError(`不正なパスセグメント: "${segment}"。特殊文字（, ) ( * ? \\）は許可されていません。`);
    }
  }

  implementationGuard(plan: TaskPlan): void {
    if (!plan.specPath) throw new GuardError("計画ファイルに spec が指定されていません。");
    if (!plan.testCasesPath) throw new GuardError("計画ファイルに test_cases が指定されていません。");
    if (!plan.scope) throw new GuardError("計画ファイルに scope が指定されていません。");
    this.validateScope(plan.scope);

    const specFullPath = resolve(this.projectRoot, plan.specPath);
    const testCasesFullPath = resolve(this.projectRoot, plan.testCasesPath);
    this.assertWithinProject(specFullPath);
    this.assertWithinProject(testCasesFullPath);

    if (!plan.targetTestCases || plan.targetTestCases.length === 0) {
      throw new GuardError("対象テストケースが指定されていません。");
    }
    if (!existsSync(specFullPath)) throw new GuardError(`仕様書が存在しません: ${plan.specPath}`);
    if (!existsSync(testCasesFullPath)) throw new GuardError(`テストケースが存在しません: ${plan.testCasesPath}`);

    const specFm = this.readFrontmatter(specFullPath);
    if (!this.isReadyLikeStatus(specFm.status)) {
      throw new GuardError(`仕様書が ready ではありません（現在: ${specFm.status ?? "なし"}）`);
    }
    const tcFm = this.readFrontmatter(testCasesFullPath);
    if (!this.isReadyLikeStatus(tcFm.status)) {
      throw new GuardError(`テストケースが ready ではありません（現在: ${tcFm.status ?? "なし"}）`);
    }
  }

  private isReadyLikeStatus(status: string | undefined): boolean {
    return status === "ready" || status === "approved";
  }

  async findSourceFiles(scope: string): Promise<string[]> {
    const sourceDir = this.resolvePattern(this.sourceLayout.sourceDir, scope);
    const testDir = this.resolvePattern(this.sourceLayout.testDir, scope);
    const dirs = [join(this.projectRoot, sourceDir)];
    const resolvedTestDir = join(this.projectRoot, testDir);
    if (!resolvedTestDir.startsWith(dirs[0] + "/") && resolvedTestDir !== dirs[0]) {
      dirs.push(resolvedTestDir);
    }
    return this.findFilesInDirs(dirs);
  }

  async findImplementationFiles(scope: string): Promise<string[]> {
    const sourceDir = this.resolvePattern(this.sourceLayout.sourceDir, scope);
    const testDir = this.resolvePattern(this.sourceLayout.testDir, scope);
    const allFiles = await this.findFilesInDirs([join(this.projectRoot, sourceDir)]);
    if (this.isColocatedScope(scope)) {
      return allFiles.filter((file) => !this.isTestLikeFile(file));
    }
    const resolvedTestDir = join(this.projectRoot, testDir);
    const testDirPrefix = resolvedTestDir.endsWith("/") ? resolvedTestDir : resolvedTestDir + "/";
    return allFiles.filter((f) => f !== resolvedTestDir && !f.startsWith(testDirPrefix));
  }

  async findTestFiles(scope: string): Promise<string[]> {
    const testDir = this.resolvePattern(this.sourceLayout.testDir, scope);
    const files = await this.findFilesInDirs([join(this.projectRoot, testDir)]);
    if (!this.isColocatedScope(scope)) return files;
    return files.filter((file) => this.isTestLikeFile(file));
  }

  async findChangedImplementationFiles(scope: string): Promise<string[]> {
    return this.filterChangedFiles(await this.findImplementationFiles(scope), await this.changedScopeFiles(scope));
  }

  async findChangedTestFiles(scope: string): Promise<string[]> {
    return this.filterChangedFiles(await this.findTestFiles(scope), await this.changedScopeFiles(scope));
  }

  async findMisplacedTestFiles(scope: string): Promise<string[]> {
    const sourceDir = this.resolvePattern(this.sourceLayout.sourceDir, scope);
    const testDir = this.resolvePattern(this.sourceLayout.testDir, scope);
    const sourceRoot = join(this.projectRoot, sourceDir);
    const expectedTestRoot = join(this.projectRoot, testDir);
    if (!existsSync(sourceRoot)) return [];

    const nameArgs: string[] = [];
    for (const pattern of this.testLikeNamePatterns()) {
      if (nameArgs.length > 0) nameArgs.push("-o");
      nameArgs.push("-name", pattern);
    }
    if (nameArgs.length === 0) return [];

    const excludeArgs: string[] = [];
    for (const excludeDir of this.excludeDirs) {
      excludeArgs.push("-not", "-path", `*/${excludeDir}/*`);
    }

    try {
      const { stdout } = await execFileAsync(
        "find",
        [sourceRoot, "-type", "f", "(", ...nameArgs, ")", ...excludeArgs],
        { timeout: LOCAL_CMD_TIMEOUT_MS },
      );
      const expectedPrefix = expectedTestRoot.endsWith("/") ? expectedTestRoot : `${expectedTestRoot}/`;
      return stdout
        .split("\n")
        .filter(Boolean)
        .filter((file) => this.isFileWithinProject(file))
        .filter((file) => file !== expectedTestRoot && !file.startsWith(expectedPrefix));
    } catch (error: unknown) {
      const execError = error as { code?: string; stderr?: string };
      if (execError.code === "ENOENT") throw new GuardError("find コマンドが見つかりません。");
      throw new GuardError(
        `${sourceRoot} のテスト候補探索に失敗しました。権限やディレクトリ構造を確認してください。\n${execError.stderr ?? ""}`,
      );
    }
  }

  private async findFilesInDirs(dirs: string[]): Promise<string[]> {
    const files: string[] = [];
    const nameArgs: string[] = [];
    for (let i = 0; i < this.fileExtensions.length; i++) {
      if (i > 0) nameArgs.push("-o");
      nameArgs.push("-name", `*.${this.fileExtensions[i]}`);
    }
    const excludeArgs: string[] = [];
    for (const excludeDir of this.excludeDirs) {
      excludeArgs.push("-not", "-path", `*/${excludeDir}/*`);
    }

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      if (lstatSync(dir).isSymbolicLink()) {
        const realDir = realpathSync(dir);
        const boundary = this.realRoot.endsWith("/") ? this.realRoot : this.realRoot + "/";
        if (!realDir.startsWith(boundary)) {
          throw new GuardError(`プロジェクト外を参照する symlink ディレクトリが検出されました: ${dir} -> ${realDir}`);
        }
      }
      try {
        const { stdout } = await execFileAsync("find", [dir, "-type", "f", "(", ...nameArgs, ")", ...excludeArgs], {
          timeout: LOCAL_CMD_TIMEOUT_MS,
        });
        for (const f of stdout.split("\n").filter(Boolean)) {
          if (this.isFileWithinProject(f)) files.push(f);
        }
      } catch (error: unknown) {
        const execError = error as { code?: string; stderr?: string };
        if (execError.code === "ENOENT") throw new GuardError("find コマンドが見つかりません。");
        throw new GuardError(`${dir} のファイル探索に失敗しました。権限やディレクトリ構造を確認してください。\n${execError.stderr ?? ""}`);
      }
    }
    return files;
  }

  private testLikeNamePatterns(): string[] {
    const patterns = new Set<string>();
    for (const ext of this.fileExtensions) {
      patterns.add(`test_*.${ext}`);
      patterns.add(`*_test.${ext}`);
      patterns.add(`*.test.${ext}`);
      patterns.add(`*.spec.${ext}`);
    }
    return [...patterns];
  }

  private isColocatedScope(scope: string): boolean {
    const sourceDir = this.resolvePattern(this.sourceLayout.sourceDir, scope);
    const testDir = this.resolvePattern(this.sourceLayout.testDir, scope);
    return join(this.projectRoot, sourceDir) === join(this.projectRoot, testDir);
  }

  private isTestLikeFile(filePath: string): boolean {
    const name = basename(filePath);
    return this.testLikeNamePatterns().some((pattern) => this.matchesGlobPattern(name, pattern));
  }

  private matchesGlobPattern(value: string, pattern: string): boolean {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*");
    return new RegExp(`^${escaped}$`).test(value);
  }

  testPathForScope(scope: string): string {
    return this.resolvePattern(this.sourceLayout.testDir, scope);
  }

  private resolvedAdditionalAllowedPrefixes(): string[] {
    return this.sourceLayout.additionalAllowedPrefixes.map((prefix) => prefix.endsWith("/") ? prefix : `${prefix}/`);
  }

  scopeAllowedTools(scope: string): string[] {
    const pattern = this.resolvePattern(this.sourceLayout.scopePattern, scope);
    return [
      "Read",
      `Write(${pattern})`,
      `Edit(${pattern})`,
      ...this.resolvedAdditionalAllowedPrefixes().flatMap((prefix) => [
        `Write(${prefix}**)`,
        `Edit(${prefix}**)`,
      ]),
    ];
  }

  implAllowedTools(scope: string): string[] {
    const sourceDir = this.resolvePattern(this.sourceLayout.sourceDir, scope);
    const testDir = this.resolvePattern(this.sourceLayout.testDir, scope);
    const extPattern = this.fileExtensions.join(",");
    return [
      "Read",
      `Write(${sourceDir}/**/*.{${extPattern}})`,
      `Edit(${sourceDir}/**/*.{${extPattern}})`,
      `Read(${testDir}/**)`,
      ...this.resolvedAdditionalAllowedPrefixes().flatMap((prefix) => [
        `Write(${prefix}**)`,
        `Edit(${prefix}**)`,
      ]),
    ];
  }

  testAllowedTools(scope: string): string[] {
    const testDir = this.resolvePattern(this.sourceLayout.testDir, scope);
    const writePatterns = this.isColocatedScope(scope)
      ? this.testLikeNamePatterns().flatMap((pattern) => [`${testDir}/${pattern}`, `${testDir}/**/${pattern}`])
      : [`${testDir}/**`];
    return [
      "Read",
      ...writePatterns.flatMap((pattern) => [`Write(${pattern})`, `Edit(${pattern})`]),
      ...this.resolvedAdditionalAllowedPrefixes().flatMap((prefix) => [
        `Write(${prefix}**)`,
        `Edit(${prefix}**)`,
      ]),
    ];
  }

  private scopeDirs(scope: string): string[] {
    const sourceDir = this.resolvePattern(this.sourceLayout.sourceDir, scope);
    const testDir = this.resolvePattern(this.sourceLayout.testDir, scope);
    const dirs = [sourceDir];
    if (testDir !== sourceDir && !testDir.startsWith(sourceDir + "/")) {
      dirs.push(testDir);
    }
    return dirs;
  }

  private async changedFilesUnderPrefixes(prefixes: string[]): Promise<string[]> {
    const tracked = await this.gitListChangedFiles("git", ["diff", "--name-only", "HEAD"]);
    const untracked = await this.gitListChangedFiles("git", ["ls-files", "--others", "--exclude-standard"]);
    const allChanged = [...tracked, ...untracked];
    return allChanged.filter((file) => prefixes.some((prefix) => file.startsWith(prefix)));
  }

  private async changedScopeFiles(scope: string): Promise<string[]> {
    const prefixes = this.scopeDirs(scope).map((dir) => dir.endsWith("/") ? dir : `${dir}/`);
    return this.changedFilesUnderPrefixes(prefixes);
  }

  private filterChangedFiles(files: string[], changedRelativeFiles: string[]): string[] {
    const changedAbsPaths = new Set(changedRelativeFiles.map((file) => resolve(this.projectRoot, file)));
    return files.filter((file) => changedAbsPaths.has(file));
  }

  async stageFiles(scope: string): Promise<void> {
    const dirs = this.scopeDirs(scope);
    const changedExtraFiles = await this.changedFilesUnderPrefixes(this.resolvedAdditionalAllowedPrefixes());
    const stageTargets = [...dirs.map((d) => `${d}/`), ...changedExtraFiles];
    if (stageTargets.length === 0) return;
    try {
      await execFileAsync("git", ["add", ...stageTargets], { cwd: this.projectRoot, timeout: 30_000 });
    } catch (error: unknown) {
      const execError = error as { code?: string };
      if (execError.code === "ENOENT") throw new GuardError("git が見つかりません。");
      throw new GuardError("git add の実行に失敗しました。");
    }
  }

  async getCurrentCommitHash(): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: this.projectRoot, timeout: 30_000 });
      return stdout.trim();
    } catch {
      return "";
    }
  }

  async countDiffLines(): Promise<number> {
    return this.countDiffLinesForFiles([]);
  }

  async countDiffLinesForFiles(files: string[]): Promise<number> {
    try {
      const relFiles = this.toRelativeProjectPaths(files);
      const args = relFiles.length > 0
        ? ["diff", "HEAD", "--numstat", "--", ...relFiles]
        : ["diff", "HEAD", "--numstat"];
      const { stdout } = await execFileAsync("git", args, { cwd: this.projectRoot, timeout: 30_000 });
      return this.sumNumstatLines(stdout);
    } catch (error: unknown) {
      const execError = error as { code?: string };
      if (execError.code === "ENOENT") throw new GuardError("git が見つかりません。");
      throw new GuardError("git diff の実行に失敗しました。差分サイズを検証できません。");
    }
  }

  async verifyChangedFilesWithinScope(scope: string): Promise<void> {
    await this.ensureChangedFilesBaseline();
    const dirs = this.scopeDirs(scope);
    const allowedPrefixes = [
      ...dirs.map((d) => d.endsWith("/") ? d : `${d}/`),
      ...this.resolvedAdditionalAllowedPrefixes(),
    ];
    const allChanged = await this.listChangedFiles();
    for (const file of allChanged) {
      const inScope = allowedPrefixes.some((prefix) => file.startsWith(prefix));
      if (!inScope && !this.isBaselineUnchanged(file)) {
        throw new GuardError(`スコープ外のファイルが変更されています: ${file}\n許可されたプレフィクス: ${allowedPrefixes.join(", ")}`);
      }
    }
  }

  private async ensureChangedFilesBaseline(): Promise<void> {
    if (this.initialChangedFileDigests !== null) return;
    const changedFiles = await this.listChangedFiles();
    this.initialChangedFileDigests = new Map(
      changedFiles.map((file) => [file, this.readFileDigest(file)]),
    );
  }

  private async listChangedFiles(): Promise<string[]> {
    const tracked = await this.gitListChangedFiles("git", ["diff", "--name-only", "HEAD"]);
    const untracked = await this.gitListChangedFiles("git", ["ls-files", "--others", "--exclude-standard"]);
    return [...tracked, ...untracked];
  }

  private isBaselineUnchanged(file: string): boolean {
    if (this.initialChangedFileDigests === null) return false;
    if (!this.initialChangedFileDigests.has(file)) return false;
    return this.initialChangedFileDigests.get(file) === this.readFileDigest(file);
  }

  private readFileDigest(projectRelativePath: string): string | null {
    const absolutePath = resolve(this.projectRoot, projectRelativePath);
    if (!existsSync(absolutePath)) return null;
    this.assertWithinProject(absolutePath);
    return createHash("sha1").update(readFileSync(absolutePath)).digest("hex");
  }

  private async gitListChangedFiles(cmd: string, args: string[]): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(cmd, args, { cwd: this.projectRoot, timeout: LOCAL_CMD_TIMEOUT_MS });
      return stdout.split("\n").filter(Boolean);
    } catch (error: unknown) {
      const execError = error as { code?: string };
      if (execError.code === "ENOENT") throw new GuardError("git が見つかりません。");
      throw new GuardError(`git コマンド失敗: ${cmd} ${args.join(" ")}`);
    }
  }

  async getFileDiff(files: string[]): Promise<string> {
    if (files.length === 0) return "";
    for (const f of files) {
      this.assertWithinProject(resolve(this.projectRoot, f));
    }
    try {
      const relFiles = this.toRelativeProjectPaths(files);
      const { stdout } = await execFileAsync("git", ["diff", "HEAD", "--", ...relFiles], {
        cwd: this.projectRoot,
        timeout: LOCAL_CMD_TIMEOUT_MS,
        maxBuffer: 5 * 1024 * 1024,
      });
      return stdout;
    } catch {
      return "(git diff 取得失敗)";
    }
  }

  readFrontmatter(filePath: string): Record<string, string> {
    this.assertWithinProject(filePath);
    const content = readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
    const match = /^---\n([\s\S]*?)\n---/.exec(content);
    if (!match) return {};
    const result: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key) result[key] = value;
    }
    return result;
  }

  private isFileWithinProject(filePath: string): boolean {
    try {
      this.assertWithinProject(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private toRelativeProjectPaths(files: string[]): string[] {
    return files.map((file) => {
      const abs = resolve(this.projectRoot, file);
      this.assertWithinProject(abs);
      return abs.startsWith(this.projectRoot) ? abs.slice(this.projectRoot.length + 1) : file;
    });
  }

  private sumNumstatLines(output: string): number {
    let total = 0;
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const [added, deleted] = line.split("\t", 3);
      const addedNum = Number.parseInt(added ?? "", 10);
      const deletedNum = Number.parseInt(deleted ?? "", 10);
      if (!Number.isNaN(addedNum)) total += addedNum;
      if (!Number.isNaN(deletedNum)) total += deletedNum;
    }
    return total;
  }
}
