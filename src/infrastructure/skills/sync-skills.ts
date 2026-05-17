import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HarnessError } from "../../domain/model/types.ts";

export const BUNDLED_SKILLS_DIR = ".harness/resources/skills";
export const SKILL_INSTALL_TARGETS = [
  ".codex/skills",
  ".claude/skills",
] as const;

export function listBundledSkills(projectRoot: string): string[] {
  const skillsRoot = join(projectRoot, BUNDLED_SKILLS_DIR);
  if (!existsSync(skillsRoot)) return [];

  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export function syncBundledSkills(projectRoot: string): string[] {
  const bundledSkills = listBundledSkills(projectRoot);
  if (bundledSkills.length === 0) {
    throw new HarnessError(`${BUNDLED_SKILLS_DIR} に配布用 skill が見つかりません。`);
  }

  for (const target of SKILL_INSTALL_TARGETS) {
    const targetRoot = join(projectRoot, target);
    mkdirSync(targetRoot, { recursive: true });

    for (const skillName of bundledSkills) {
      cpSync(
        join(projectRoot, BUNDLED_SKILLS_DIR, skillName),
        join(targetRoot, skillName),
        { recursive: true, force: true },
      );
    }
  }

  return bundledSkills;
}
