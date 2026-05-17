import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriftGuard } from "./drift-guard.ts";
import { HarnessLogger } from "../../infrastructure/logging/logger.ts";
import { DriftError, ESCALATION_LEVEL } from "../../domain/model/types.ts";

function createGuard(options?: { codexAvailable?: boolean }): DriftGuard {
  const workspace = mkdtempSync(join(tmpdir(), "harness-drift-"));
  const logger = new HarnessLogger("drift-test", { baseDir: workspace });
  const guard = new DriftGuard(logger, options);
  guard.startTask("scope/name", 10);
  return guard;
}

test("DriftGuard escalates repeated test failures across levels", () => {
  const guard = createGuard({ codexAvailable: true });

  assert.equal(guard.recordTestAttempt("suite", false, "same"), null);
  assert.equal(guard.recordTestAttempt("suite", false, "same"), null);
  const level1 = guard.recordTestAttempt("suite", false, "same");
  assert.equal(level1, ESCALATION_LEVEL.LEVEL_1);
  const level2 = guard.recordTestAttempt("suite", false, "same");
  assert.equal(level2, ESCALATION_LEVEL.LEVEL_2);
});

test("DriftGuard throws level 3 when codex is unavailable and failures continue", () => {
  const guard = createGuard({ codexAvailable: false });
  guard.handleDrift("test_retry", 2);

  assert.throws(
    () => guard.handleDrift("test_retry", 3),
    (error: unknown) =>
      error instanceof DriftError &&
      error.level === ESCALATION_LEVEL.LEVEL_3 &&
      error.metric === "test_retry",
  );
});

test("DriftGuard detects diff scope and repeated rollbacks", () => {
  const guard = createGuard();

  guard.checkDiffScope(31);
  assert.throws(
    () => {
      guard.recordFileRollback("file.ts");
      guard.recordFileRollback("file.ts");
      guard.recordFileRollback("file.ts");
    },
    (error: unknown) => error instanceof DriftError && error.metric === "file_rollback",
  );
});

test("DriftGuard resets successful test attempts", () => {
  const guard = createGuard();
  guard.recordTestAttempt("suite", false, "one");
  guard.recordTestAttempt("suite", true);
  assert.equal(guard.recordTestAttempt("suite", false, "two"), null);
});
