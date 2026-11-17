import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import test from "node:test";

const script = join(resolve(__dirname, "..", ".."), "scripts", "marketplace-version.cjs");

function run(version: string) {
  return spawnSync(process.execPath, [script, version], { encoding: "utf8" });
}

function preview(version: string) {
  const result = run(version);
  assert.equal(result.status, 0, `expected "${version}" to be accepted: ${result.stderr}`);
  return result.stdout.trim();
}

function ordered(left: string, right: string) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  return a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];
}

test("preview version publishes in the preview patch lane", () => {
  assert.equal(preview("v1.12.0"), "1.12.1000");
  assert.equal(preview("1.12.0"), "1.12.1000");
  assert.equal(preview(" 2.0.9 "), "2.0.1009");
});

test("preview versions never collide with the stable releases they precede", () => {
  // The regression this guards: the preview of v1.12.0 must not claim 1.12.1,
  // because that is the version the next fix release publishes as stable and
  // vsce --skip-duplicate would then skip the validated stable artifact.
  assert.notEqual(preview("v1.12.0"), "1.12.1");
  assert.notEqual(preview("v1.12.1"), "1.12.1");
  assert.equal(preview("v1.12.1"), "1.12.1001");

  // Monotonic across consecutive patches and across a minor bump.
  assert.ok(ordered(preview("v1.12.0"), preview("v1.12.1")));
  assert.ok(ordered(preview("v1.12.9"), preview("v1.13.0")));
});

test("preview version rejects anything the Marketplace would not accept", () => {
  for (const invalid of ["1.12.0-preview.42.1", "1.12", "v1.12.0.1", ""]) {
    const result = run(invalid);
    assert.equal(result.status, 1, `expected "${invalid}" to be rejected`);
    assert.match(result.stderr, /Expected a stable version/);
  }
});

test("preview version refuses to overlap a stable version that reaches the lane", () => {
  const result = run("1.12.1000");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /preview patch offset/);
});
