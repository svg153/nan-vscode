import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureDiagnosticFile, diagnostic } from "../src/diagnostics";

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
