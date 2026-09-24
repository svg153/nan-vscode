const path = require("node:path");
const { runTests } = require("@vscode/test-electron");

const root = path.resolve(__dirname, "..");
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
