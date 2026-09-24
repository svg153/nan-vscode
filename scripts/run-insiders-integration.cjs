const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { runTests } = require("@vscode/test-electron");

const root = path.resolve(__dirname, "..");

if (process.platform === "linux" && !process.env.DISPLAY) {
  const result = spawnSync("xvfb-run", ["-a", process.execPath, __filename], { stdio: "inherit" });
  if (result.error) {
    console.error("Insiders integration requires xvfb-run on headless Linux.");
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
} else {
  runTests({
    version: "insiders",
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, "out", "test", "insidersIntegration.js"),
    reuseMachineInstall: false,
    launchArgs: [
      `--user-data-dir=${path.join(root, ".vscode-test", "user-data")}`,
      `--extensions-dir=${path.join(root, ".vscode-test", "extensions")}`,
      "--disable-extensions",
    ],
  }).catch((error) => {
    console.error(`Insiders integration runner failed (${error.name}; details redacted).`);
    process.exitCode = 1;
  });
}
