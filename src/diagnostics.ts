import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Temporary local crash diagnostics. Remove after identifying the Insiders restart cause. */
let logFile: string | undefined;
let enabled = false;

export function configureDiagnosticFile(directory: string, diagnosticsEnabled: boolean): void {
  enabled = diagnosticsEnabled;
  logFile = undefined;
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
  console.info("[NaN-DEBUG]", line);
  if (logFile) {
    try {
      appendFileSync(logFile, `${line}\n`, "utf8");
    } catch {
      logFile = undefined;
    }
  }
}
