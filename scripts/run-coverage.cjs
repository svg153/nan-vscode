"use strict";

const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");
const { execSync } = require("node:child_process");

const root = resolve(__dirname, "..");

// Run tests with c8, capturing coverage data but not failing on test exit
// c8 --retry-avx2 handles some CPU issues; we use --reporter=none to skip auto-report
const c8Cmd = process.platform === "win32" ? "npx.cmd" : "npx";
const c8Result = spawnSync(
  c8Cmd,
  ["c8", "--reporter=lcov", "--reporter=none", "--report-dir", "coverage",
   "node", "--test", "out/test/*.test.js"],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: "--no-warnings" },
  },
);

// Always generate coverage summary and run gate, regardless of test result
const summaryResult = spawnSync(
  process.execPath,
  [resolve(__dirname, "generate-coverage-summary.cjs")],
  { cwd: root, stdio: "inherit" },
);

if (summaryResult.status !== 0) {
  process.exit(summaryResult.status || 1);
}

const gateResult = spawnSync(
  process.execPath,
  [resolve(__dirname, "check-coverage.cjs")],
  { cwd: root, stdio: "inherit" },
);

// Exit with test failure status if tests failed, otherwise use gate status
process.exit(c8Result.status !== 0 ? c8Result.status : gateResult.status);