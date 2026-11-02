"use strict";

const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const reportDirectory = path.join(root, "dependency-audit");
const npmExecPath = process.env.npm_execpath;
const command = npmExecPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const args = npmExecPath
  ? [npmExecPath, "audit", "--json", "--package-lock-only"]
  : ["audit", "--json", "--package-lock-only"];
const result = spawnSync(command, args, {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
  shell: !npmExecPath && process.platform === "win32",
});

if (result.error) {
  console.error(`Dependency audit could not start: ${result.error.message}`);
  process.exitCode = 1;
} else {
  let audit;
  try {
    audit = JSON.parse(result.stdout);
  } catch {
    console.error(result.stderr || "Dependency audit did not return valid JSON.");
    process.exitCode = 1;
  }

  if (audit) {
    if (audit.error || !audit.metadata?.vulnerabilities || !audit.vulnerabilities) {
      console.error(JSON.stringify(audit.error ?? audit, null, 2));
      process.exitCode = 1;
    } else {
      mkdirSync(reportDirectory, { recursive: true });
      writeFileSync(path.join(reportDirectory, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
      writeFileSync(path.join(reportDirectory, "summary.md"), buildSummary(audit), "utf8");
      const { total = 0, critical = 0, high = 0, moderate = 0, low = 0, info = 0 } =
        audit.metadata.vulnerabilities;
      console.log(
        `Dependency audit report written: ${total} advisories ` +
          `(critical ${critical}, high ${high}, moderate ${moderate}, low ${low}, info ${info}).`,
      );
    }
  }
}

function buildSummary(audit) {
  const counts = audit.metadata.vulnerabilities;
  const vulnerabilities = Object.entries(audit.vulnerabilities).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const lines = [
    "# Dependency audit",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "Source: `package-lock.json`; production and development dependencies are included.",
    "",
    `**Totals:** ${counts.total} advisories — critical ${counts.critical}, high ${counts.high}, ` +
      `moderate ${counts.moderate}, low ${counts.low}, info ${counts.info}.`,
    "",
    "Existing advisories are reported without failing CI. See `docs/DEPENDENCY-AUDIT.md` for baseline triage policy.",
    "",
    "| Package | Severity | Type | Range | Installed dependency paths | Advisory | Fix available |",
    "|---|---|---|---|---|---|---|",
  ];

  for (const [name, vulnerability] of vulnerabilities) {
    const type = vulnerability.isDirect ? "direct" : "transitive";
    const paths = Array.isArray(vulnerability.nodes) && vulnerability.nodes.length
      ? vulnerability.nodes.join(", ")
      : "not reported";
    const advisory = Array.isArray(vulnerability.via)
      ? vulnerability.via
          .filter((entry) => typeof entry === "object" && entry !== null)
          .map((entry) => `${entry.title ?? entry.name ?? "advisory"}${entry.url ? ` (${entry.url})` : ""}`)
          .join("; ") || "via dependency chain"
      : "not reported";
    const fix = typeof vulnerability.fixAvailable === "object"
      ? JSON.stringify(vulnerability.fixAvailable)
      : String(vulnerability.fixAvailable ?? "unknown");
    lines.push(
      `| ${cell(name)} | ${cell(vulnerability.severity)} | ${type} | ${cell(vulnerability.range)} | ` +
        `${cell(paths)} | ${cell(advisory)} | ${cell(fix)} |`,
    );
  }

  if (vulnerabilities.length === 0) {
    lines.push("| — | — | — | — | — | No vulnerabilities found | — |");
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function cell(value) {
  return String(value ?? "not reported").replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");
}
