import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedProfileConfig } from "../config/config.ts";
import type { RunnerRequest } from "./runner.ts";
import type { FlowStep } from "../../domain/model/steps.ts";
import { GuardError } from "../../domain/model/types.ts";

export type StepContext = {
  agent?: string;
  skillNames: string[];
  mcpConfigs: string[];
};

export function applyStepContext(
  request: RunnerRequest,
  profile: ResolvedProfileConfig | undefined,
  step: FlowStep,
  projectRoot: string,
): RunnerRequest {
  const context = resolveStepContext(profile, step);
  return {
    ...request,
    agent: context.agent ?? request.agent,
    mcpConfigs: uniqueStrings([...(request.mcpConfigs ?? []), ...context.mcpConfigs]),
    appendSystemPrompt: joinPromptSections([
      context.skillNames.length > 0 ? loadSkillPrompt(projectRoot, context.skillNames) : "",
      request.appendSystemPrompt,
    ]),
  };
}

export function resolveStepContext(
  profile: ResolvedProfileConfig | undefined,
  step: FlowStep,
): StepContext {
  const profileContext = profile?.context;
  const stepOverride = profileContext?.stepOverrides[step];
  return {
    agent: stepOverride?.agent ?? profileContext?.defaultAgent,
    skillNames: uniqueStrings([
      ...(profileContext?.defaultSkills ?? []),
      ...(stepOverride?.skills ?? []),
    ]),
    mcpConfigs: uniqueStrings([
      ...(profileContext?.defaultMcpConfigs ?? []),
      ...(stepOverride?.mcpConfigs ?? []),
    ]),
  };
}

export function joinPromptSections(sections: Array<string | undefined>): string | undefined {
  const normalized = sections
    .map((section) => section?.trim())
    .filter((section): section is string => Boolean(section));
  if (normalized.length === 0) return undefined;
  return normalized.join("\n\n");
}

export function findSkillFilePath(projectRoot: string, skillName: string): string | null {
  const preferred = join(projectRoot, ".codex", "skills", skillName, "SKILL.md");
  if (existsSync(preferred)) return preferred;

  const bundled = join(projectRoot, ".harness", "resources", "skills", skillName, "SKILL.md");
  if (existsSync(bundled)) return bundled;

  const legacy = join(projectRoot, ".claude", "skills", skillName, "SKILL.md");
  if (existsSync(legacy)) return legacy;

  return null;
}

function loadSkillPrompt(projectRoot: string, skillNames: string[]): string {
  const sections = skillNames.map((skillName) => {
    const skillPath = findSkillFilePath(projectRoot, skillName);
    if (!skillPath) {
      throw new GuardError(`Harness skill not found: .codex/skills/${skillName}/SKILL.md or .harness/resources/skills/${skillName}/SKILL.md`);
    }
    const content = readFileSync(skillPath, "utf-8").trim();
    return `## Loaded Skill: ${skillName}\n${content}`;
  });

  return [
    "## Harness-loaded skills",
    "Use the following project-local skills as authoritative task guidance for this step.",
    ...sections,
  ].join("\n\n");
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
