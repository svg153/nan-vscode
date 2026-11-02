import { appendFileSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Opt-in local diagnostics for provider and status-bar troubleshooting.
 * Disabled by default: nothing is written to disk unless the user enables it.
 * When enabled, JSON lines are appended to a size-bounded log file.
 */
export const MAX_DIAGNOSTIC_LOG_BYTES = 1_048_576;

let logFile: string | undefined;
let enabled = false;
let outputChannel: { appendLine(value: string): void } | undefined;

export function configureDiagnosticFile(
  directory: string,
  diagnosticsEnabled: boolean,
  channel?: { appendLine(value: string): void },
): void {
  enabled = diagnosticsEnabled;
  logFile = undefined;
  outputChannel = diagnosticsEnabled ? channel : undefined;
  if (!enabled) {
    return;
  }

  try {
    mkdirSync(directory, { recursive: true });
    logFile = join(directory, "nan-vscode-diagnostics.log");
    diagnostic("diagnostic.file.ready");
  } catch {
    logFile = undefined;
  }
}

export function diagnostic(event: string, details: Record<string, string | number | boolean> = {}): void {
  if (!enabled) {
    return;
  }

  const memory = process.memoryUsage();
  const line = JSON.stringify({
    at: new Date().toISOString(),
    pid: process.pid,
    uptimeSeconds: Math.floor(process.uptime()),
    event,
    rssMb: Math.round(memory.rss / 1_048_576),
    heapUsedMb: Math.round(memory.heapUsed / 1_048_576),
    ...details,
  });
  outputChannel?.appendLine(line);
  if (logFile) {
    try {
      rotateIfFull(logFile);
      appendFileSync(logFile, `${line}\n`, "utf8");
    } catch {
      logFile = undefined;
    }
  }
}

/** Keep the log bounded: rotate the full file to `<log>.1`, truncating if rotation fails. */
function rotateIfFull(file: string): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size < MAX_DIAGNOSTIC_LOG_BYTES) {
    return;
  }
  try {
    renameSync(file, `${file}.1`);
  } catch {
    writeFileSync(file, "", "utf8");
  }
}
