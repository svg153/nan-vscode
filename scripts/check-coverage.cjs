const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const minimumLineCoverage = 58.99;
const summaryPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(__dirname, "..", "coverage", "coverage-summary.json");
const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const lineCount = summary.total?.lines?.total;
const coveredLines = summary.total?.lines?.covered;

if (
  typeof lineCount !== "number" ||
  !Number.isInteger(lineCount) ||
  lineCount <= 0 ||
  typeof coveredLines !== "number" ||
  !Number.isInteger(coveredLines) ||
  coveredLines < 0 ||
  coveredLines > lineCount
) {
  throw new Error(`Coverage summary does not contain valid total line counts: ${summaryPath}`);
}

const measuredLineCoverage = (coveredLines / lineCount) * 100;
console.log(
  `Source line coverage: ${measuredLineCoverage.toFixed(4)}% (minimum ${minimumLineCoverage.toFixed(2)}%).`,
);

const minimumCoverageBasisPoints = Math.round(minimumLineCoverage * 100);
if (coveredLines * 10_000 < lineCount * minimumCoverageBasisPoints) {
  console.error(
    `Coverage gate failed: measured ${measuredLineCoverage.toFixed(4)}%, required ${minimumLineCoverage.toFixed(2)}%.`,
  );
  process.exitCode = 1;
}
