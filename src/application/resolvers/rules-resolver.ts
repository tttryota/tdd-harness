import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PlanType } from "../../domain/model/types.ts";

export type ResolvedRuleSet = {
  ruleName?: string;
  content: string;
};

export function resolveRuleName(planType: PlanType, profile: string): string | undefined {
  if (planType === "impl" && profile === "frontend") {
    return "logic";
  }
  return planType;
}

export function resolveRulesContent(projectRoot: string, ruleName?: string): ResolvedRuleSet {
  if (!ruleName) {
    return { ruleName, content: "" };
  }

  const projectPath = join(projectRoot, ".harness", "resources", "rules", `${ruleName}.md`);
  if (existsSync(projectPath)) {
    return { ruleName, content: readFileSync(projectPath, "utf-8") };
  }

  const packagePath = join(import.meta.dirname ?? "", "..", "..", "..", "resources", "rules", `${ruleName}.md`);
  if (existsSync(packagePath)) {
    return { ruleName, content: readFileSync(packagePath, "utf-8") };
  }

  return { ruleName, content: "" };
}

export function buildMswInstructions(msw: boolean, mode: "test" | "impl"): string {
  if (!msw) return "";

  if (mode === "test") {
    return `## MSW セットアップ
- テストファイルに MSW server のセットアップ (beforeAll/afterEach/afterAll) を含める
- API モック用の handler import を含める（handler ファイルは実装フェーズで生成される）
- handler の配置先: frontend/src/mocks/handlers/
- server.use(...handlers) でモックを適用する`;
  }

  return `## MSW ハンドラ生成
- frontend/src/mocks/handlers/ に共有ハンドラファイルを生成する
- ハンドラのレスポンス形状はバックエンド API の契約と一致させる
- テストファイルから import されるパスと一致させる`;
}
