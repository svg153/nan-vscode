import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("coverage gate accepts the baseline and rejects a lower report", () => {
  const projectRoot = resolve(__dirname, "..", "..");
  const gateScript = join(projectRoot, "scripts", "check-coverage.cjs");
  const passingSummary = join(tmpdir(), `coverage-summary-${randomUUID()}.json`);
  const failingSummary = join(tmpdir(), `coverage-summary-${randomUUID()}.json`);

  writeFileSync(passingSummary, JSON.stringify({ total: { lines: { total: 10_000, covered: 5_899 } } }));
  writeFileSync(failingSummary, JSON.stringify({ total: { lines: { total: 10_000, covered: 5_898 } } }));

  try {
    const passing = spawnSync(process.execPath, [gateScript, passingSummary], { encoding: "utf8" });
    assert.equal(passing.status, 0, passing.stderr);
    assert.match(passing.stdout, /58\.9900% \(minimum 58\.99%\)/);

    const failing = spawnSync(process.execPath, [gateScript, failingSummary], { encoding: "utf8" });
    assert.equal(failing.status, 1, failing.stderr);
    assert.match(failing.stderr, /measured 58\.9800%, required 58\.99%/);
  } finally {
    unlinkSync(passingSummary);
    unlinkSync(failingSummary);
  }
});
