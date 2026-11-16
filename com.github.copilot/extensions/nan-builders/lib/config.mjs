// Plugin config storage. Keys live in $COPILOT_HOME/extensions/nan-builders/artifacts/config.json
// (user-global even for the project-scoped plugin; never in the repo), mirroring how the
// VS Code extension keeps the key in secret storage. NAN_BUILDERS_API_KEY overrides the file.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_BASE_URL, NanError, classifyBaseUrl, normalizeBaseUrl } from "./nan.mjs";

export function copilotHome() {
  const value = process.env.COPILOT_HOME;
  return value && value.trim() ? value.trim() : join(homedir(), ".copilot");
}

export function configPath() {
  return join(copilotHome(), "extensions", "nan-builders", "artifacts", "config.json");
}

async function readRaw() {
  try {
    const parsed = JSON.parse(await readFile(configPath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeRaw(value) {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

export async function loadConfig() {
  const raw = await readRaw();
  const envKey = String(process.env.NAN_BUILDERS_API_KEY ?? "").trim();
  const fileKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  const apiKey = envKey || fileKey;
  return {
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    apiKey,
    hasKey: apiKey.length > 0,
    keySource: envKey ? "environment" : fileKey ? "config-file" : undefined,
    insecureConfirmed: raw.insecureConfirmed === true,
  };
}

/** Store (or clear with "") the API key. The key itself is never returned or logged. */
export async function saveApiKey(key) {
  const raw = await readRaw();
  const trimmed = String(key ?? "").trim();
  if (trimmed) {
    raw.apiKey = trimmed;
  } else {
    delete raw.apiKey;
  }
  await writeRaw(raw);
  return { hasKey: trimmed.length > 0 };
}

export async function saveBaseUrl(url, { confirmInsecure = false } = {}) {
  const value = normalizeBaseUrl(url);
  const kind = classifyBaseUrl(value);
  if (kind === "invalid") {
    throw new NanError("bad_request", "Base URL must be a valid http(s) URL.");
  }
  const insecure = kind === "http-insecure";
  if (insecure && !confirmInsecure) {
    throw new NanError("confirmation_required", "Plain HTTP to a non-loopback host sends your key unencrypted; re-save with explicit confirmation to allow it.");
  }
  const raw = await readRaw();
  if (value === DEFAULT_BASE_URL) {
    delete raw.baseUrl;
  } else {
    raw.baseUrl = value;
  }
  if (insecure) {
    raw.insecureConfirmed = true;
  } else {
    delete raw.insecureConfirmed;
  }
  await writeRaw(raw);
  return { baseUrl: value, insecure };
}
