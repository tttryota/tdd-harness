import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessError } from "../../domain/model/types.ts";
import { BUNDLED_SKILLS_DIR, listBundledSkills, SKILL_INSTALL_TARGETS, syncBundledSkills } from "./sync-skills.ts";

test("listBundledSkills and syncBundledSkills install managed copies for codex and claude", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-sync-skills-"));
  mkdirSync(join(root, ".harness", "resources", "skills", "alpha"), { recursive: true });
  mkdirSync(join(root, ".harness", "resources", "skills", "beta"), { recursive: true });
  writeFileSync(join(root, ".harness", "resources", "skills", "alpha", "SKILL.md"), "alpha", "utf-8");
  writeFileSync(join(root, ".harness", "resources", "skills", "beta", "SKILL.md"), "beta", "utf-8");

  assert.deepEqual(listBundledSkills(root), ["alpha", "beta"]);
  assert.deepEqual(syncBundledSkills(root), ["alpha", "beta"]);

  for (const target of SKILL_INSTALL_TARGETS) {
    assert.equal(
      readFileSync(join(root, target, "alpha", "SKILL.md"), "utf-8"),
      "alpha",
    );
    assert.equal(
      readFileSync(join(root, target, "beta", "SKILL.md"), "utf-8"),
      "beta",
    );
  }
});

test("syncBundledSkills fails closed when no distributable skills exist", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-sync-skills-empty-"));
  mkdirSync(join(root, BUNDLED_SKILLS_DIR), { recursive: true });
  assert.throws(() => syncBundledSkills(root), HarnessError);
});
