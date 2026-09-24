const path = require("node:path");
const { runTests } = require("@vscode/test-electron");

const root = path.resolve(__dirname, "..");
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) {
  throw new Error("Windows LOCALAPPDATA is required.");
}

runTests({
  vscodeExecutablePath: path.join(localAppData, "Programs", "Microsoft VS Code Insiders", "Code - Insiders.exe"),
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, "out", "test", "insidersIntegration.js"),
  reuseMachineInstall: true,
  launchArgs: [
    `--user-data-dir=${path.join(root, ".vscode-test", "user-data")}`,
    `--extensions-dir=${path.join(root, ".vscode-test", "extensions")}`,
    "--disable-extensions",
  ],
}).catch((error) => {
  console.error(`Insiders integration runner failed (${error.name}; details redacted).`);
  process.exitCode = 1;
});
