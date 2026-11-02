"use strict";

const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const root = resolve(__dirname, "..");
const lcovPath = resolve(root, "coverage", "lcov.info");
const summaryPath = resolve(root, "coverage", "coverage-summary.json");

const lcovContent = readFileSync(lcovPath, "utf8");

// Parse lcov format
const files = {};
let currentFile = null;

for (const line of lcovContent.split("\n")) {
  const trimmed = line.trim();

  if (trimmed.startsWith("SF:")) {
    currentFile = trimmed.substring(3);
    files[currentFile] = { lines: 0, covered: 0 };
  } else if (trimmed.startsWith("DA:") && currentFile) {
      // DA:lineNum,hits — split on ':' first, then on ','
      const afterPrefix = trimmed.substring(3); // remove "DA:"
      const parts = afterPrefix.split(",");
      const lineNum = parseInt(parts[0], 10);
      const hits = parseInt(parts[1], 10);
      if (!files[currentFile].linesMap) {
        files[currentFile].linesMap = {};
      }
      files[currentFile].linesMap[lineNum] = hits;
      files[currentFile].lines++;
      if (hits > 0) {
        files[currentFile].covered++;
      }
  } else if (trimmed === "end_of_record") {
    currentFile = null;
  }
}

let totalLines = 0;
let coveredLines = 0;

for (const file of Object.values(files)) {
  totalLines += file.lines;
  coveredLines += file.covered;
}

const summary = {
  total: {
    lines: { total: totalLines, covered: coveredLines, skipped: 0 },
    statements: { total: 0, covered: 0, skipped: 0 },
    branches: { total: 0, covered: 0, skipped: 0 },
    functions: { total: 0, covered: 0, skipped: 0 },
  },
  files: Object.keys(files).map((file) => {
    const data = files[file];
    const pct = data.lines ? Math.round((data.covered / data.lines) * 100) : 100;

    return {
      path: file,
      statement: { total: 0, covered: 0, skipped: 0, pct: 100 },
      branch: { total: 0, covered: 0, skipped: 0, pct: 100 },
      function: { total: 0, covered: 0, skipped: 0, pct: 100 },
      line: { total: data.lines, covered: data.covered, skipped: 0, pct },
    };
  }),
};

writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
console.log(`Coverage summary written: ${summaryPath}`);
console.log(`Lines: ${coveredLines}/${totalLines} (${Math.round((coveredLines / totalLines) * 100)}%)`);