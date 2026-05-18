import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessError } from "../../domain/model/types.ts";
import { loadTemplate, renderTemplate } from "./templates.ts";

test("loadTemplate prefers config overrides over project conventions", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-template-"));
  mkdirSync(join(root, ".harness", "resources", "templates"), { recursive: true });
  writeFileSync(join(root, ".harness", "resources", "templates", "review.md"), "project", "utf-8");
  writeFileSync(join(root, "custom.md"), "override", "utf-8");

  assert.equal(loadTemplate("review", root, { review: "custom.md" }), "override");
  assert.equal(loadTemplate("review", root, {}), "project");
});

test("loadTemplate falls back to bundled templates and throws for missing names", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-template-builtin-"));
  assert.match(loadTemplate("review-response-format", root), /checklist/i);
  const specTemplate = loadTemplate("spec-template", root);
  assert.match(specTemplate, /# 具体例/);
  assert.match(specTemplate, /# 技術判断/);
  assert.match(specTemplate, /# スコープ外/);
  assert.match(specTemplate, /# 受け入れ基準/);
  assert.match(specTemplate, /各主要ルールに対して最低1つ/);
  assert.match(specTemplate, /送出する例外の型名と発生条件/);
  assert.match(specTemplate, /呼び出し元との契約/);
  const testCaseTemplate = loadTemplate("test-case-template", root);
  assert.match(testCaseTemplate, /# 検証焦点/);
  assert.match(testCaseTemplate, /# 網羅性チェック/);
  assert.match(testCaseTemplate, /受け入れ基準の各項目に対応するテストケース/);
  const testGenerateTemplate = loadTemplate("test-generate", root);
  assert.match(testGenerateTemplate, /except Exception/);
  assert.match(testGenerateTemplate, /broad exception 捕捉は使わない/);
  assert.match(testGenerateTemplate, /静的 import/);
  assert.match(testGenerateTemplate, /importlib/);
  assert.match(testGenerateTemplate, /公開 API/);
  assert.throws(() => loadTemplate("missing-template", root), HarnessError);
});

test("renderTemplate replaces known variables and blanks unknown placeholders", () => {
  assert.equal(
    renderTemplate("Hello {{name}} from {{city}} / {{missing}}", { name: "Codex", city: "Tokyo" }),
    "Hello Codex from Tokyo / ",
  );
});
