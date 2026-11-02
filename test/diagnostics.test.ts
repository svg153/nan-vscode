import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_DIAGNOSTIC_LOG_BYTES, configureDiagnosticFile, diagnostic } from "../src/diagnostics";

test("diagnostics stay silent by default and write metadata when enabled", () => {
  const directory = mkdtempSync(join(tmpdir(), "nan-vscode-diagnostics-"));
  const file = join(directory, "nan-vscode-diagnostics.log");
  const logged: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => logged.push(args.join(" "));

  try {
    configureDiagnosticFile(directory, false);
    diagnostic("disabled");
    assert.deepEqual(logged, []);
    assert.equal(existsSync(file), false);

    configureDiagnosticFile(directory, true);
    diagnostic("heartbeat");
    assert.equal(logged.length, 2);
    assert.match(readFileSync(file, "utf8"), /"event":"heartbeat"/);
  } finally {
    configureDiagnosticFile(directory, false);
    console.info = originalInfo;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rotates the diagnostic log once it reaches the size limit", () => {
  const directory = mkdtempSync(join(tmpdir(), "nan-vscode-diagnostics-"));
  const file = join(directory, "nan-vscode-diagnostics.log");
  const originalInfo = console.info;
  console.info = () => {};

  try {
    writeFileSync(file, "x".repeat(MAX_DIAGNOSTIC_LOG_BYTES), "utf8");
    configureDiagnosticFile(directory, true);
    diagnostic("after-rotation");

    const rotated = `${file}.1`;
    assert.equal(existsSync(rotated), true);
    assert.equal(statSync(rotated).size, MAX_DIAGNOSTIC_LOG_BYTES);
    assert.ok(statSync(file).size < MAX_DIAGNOSTIC_LOG_BYTES);
    assert.match(readFileSync(file, "utf8"), /"event":"after-rotation"/);
  } finally {
    configureDiagnosticFile(directory, false);
    console.info = originalInfo;
    rmSync(directory, { recursive: true, force: true });
  }
});
