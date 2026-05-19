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
  assert.match(specTemplate, /# モジュール構成/);
  assert.match(specTemplate, /概ね 200-300 行に収まる/);
  assert.match(specTemplate, /単一ファイルで実装する/);
  assert.match(specTemplate, /各主要ルールに対して最低1つ/);
  assert.match(specTemplate, /送出する例外の型名と発生条件/);
  assert.match(specTemplate, /呼び出し元との契約/);
  const testCaseTemplate = loadTemplate("test-case-template", root);
  assert.match(testCaseTemplate, /# 検証焦点/);
  assert.match(testCaseTemplate, /# 網羅性チェック/);
  assert.match(testCaseTemplate, /受け入れ基準の各項目に対応するテストケース/);
  assert.match(testCaseTemplate, /検証粒度を明示/);
  assert.match(testCaseTemplate, /ログ検証を含む場合/);
  assert.match(testCaseTemplate, /件数制約/);
  assert.match(testCaseTemplate, /例外検証を含む場合/);
  const reviewTestQualityTemplate = loadTemplate("review-test-quality", root);
  assert.match(reviewTestQualityTemplate, /検証強度がテストケース文書の期待結果の粒度と一致/);
  assert.match(reviewTestQualityTemplate, /件数の exact match を要求しない/);
  assert.match(reviewTestQualityTemplate, /完全一致を要求しない/);
  assert.match(reviewTestQualityTemplate, /書かれていない検証を追加要求しない/);
  const testGenerateTemplate = loadTemplate("test-generate", root);
  assert.match(testGenerateTemplate, /except Exception/);
  assert.match(testGenerateTemplate, /broad exception 捕捉は使わない/);
  assert.match(testGenerateTemplate, /静的 import/);
  assert.match(testGenerateTemplate, /importlib/);
  assert.match(testGenerateTemplate, /公開 API/);
  const implGenerateTemplate = loadTemplate("impl-generate", root);
  assert.match(implGenerateTemplate, /スコープ外ファイルは読み取り専用/);
  assert.match(implGenerateTemplate, /実装コードと、それに対応するテストコードだけ/);
  assert.match(implGenerateTemplate, /モジュール構成/);
  assert.match(implGenerateTemplate, /新しいファイル構成やモジュール分割を、その場の判断で発明しない/);
  assert.match(implGenerateTemplate, /notes/);
  const implRetryTemplate = loadTemplate("impl-retry", root);
  assert.match(implRetryTemplate, /スコープ外ファイルは読み取り専用/);
  assert.match(implRetryTemplate, /実装コードと、それに対応するテストコードだけ/);
  assert.match(implRetryTemplate, /モジュール構成/);
  assert.match(implRetryTemplate, /新しいファイル構成やモジュール分割を、その場の判断で発明しない/);
  const reviewImplCriteriaTemplate = loadTemplate("review-impl-criteria", root);
  assert.match(reviewImplCriteriaTemplate, /モジュール構成/);
  assert.match(reviewImplCriteriaTemplate, /新規ファイル作成やファイル分割を伴う構造再設計は要求しない/);
  assert.match(reviewImplCriteriaTemplate, /行数だけを根拠にした分割要求はしない/);
  assert.throws(() => loadTemplate("missing-template", root), HarnessError);
});

test("renderTemplate replaces known variables and blanks unknown placeholders", () => {
  assert.equal(
    renderTemplate("Hello {{name}} from {{city}} / {{missing}}", { name: "Codex", city: "Tokyo" }),
    "Hello Codex from Tokyo / ",
  );
});
