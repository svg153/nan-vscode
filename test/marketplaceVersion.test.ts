import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import test from "node:test";

const script = join(resolve(__dirname, "..", ".."), "scripts", "marketplace-version.cjs");

function run(version: string) {
  return spawnSync(process.execPath, [script, version], { encoding: "utf8" });
}

test("preview version is the patch after the stable release", () => {
  assert.equal(run("v1.12.0").stdout.trim(), "1.12.1");
  assert.equal(run("1.12.0").stdout.trim(), "1.12.1");
  assert.equal(run(" 2.0.9 ").stdout.trim(), "2.0.10");
});

test("preview version rejects anything the Marketplace would not accept", () => {
  for (const invalid of ["1.12.0-preview.42.1", "1.12", "v1.12.0.1", ""]) {
    const result = run(invalid);
    assert.equal(result.status, 1, `expected "${invalid}" to be rejected`);
    assert.match(result.stderr, /Expected a stable version/);
  }
});
