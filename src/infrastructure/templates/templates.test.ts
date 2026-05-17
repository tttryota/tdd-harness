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
  assert.throws(() => loadTemplate("missing-template", root), HarnessError);
});

test("renderTemplate replaces known variables and blanks unknown placeholders", () => {
  assert.equal(
    renderTemplate("Hello {{name}} from {{city}} / {{missing}}", { name: "Codex", city: "Tokyo" }),
    "Hello Codex from Tokyo / ",
  );
});
