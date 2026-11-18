import type { OpenAIUsage } from "./openai/types";

/**
 * VS Code 1.146 has an observed, undocumented `LanguageModelDataPart` usage
 * wire format. Keep all compatibility logic here so it can be replaced with
 * the eventual supported, typed API without changing SSE parsing or billing.
 */
export interface NativeChatUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function normalizeNativeChatUsage(usage: OpenAIUsage | undefined): NativeChatUsage | undefined {
  if (!usage || usage.estimated === true || usage.nan_truncation === true) {
    return undefined;
  }

  const prompt = usage.prompt_tokens;
  const completion = usage.completion_tokens;
  if (!validCount(prompt) || !validCount(completion)) {
    return undefined;
  }

  const sum = prompt + completion;
  if (!Number.isSafeInteger(sum)) {
    return undefined;
  }

  const total = usage.total_tokens === undefined ? sum : usage.total_tokens;
  if (!validCount(total) || total < sum) {
    return undefined;
  }

  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

/** Experimental bridge was first observed on VS Code 1.146. */
export function supportsNativeChatUsage(version: string): boolean {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?(?:[-+][\w.-]+)?$/.exec(version);
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 1 || (major === 1 && minor >= 146);
}

export interface NativeChatUsageHost<T> {
  readonly enabled: boolean;
  readonly version: string;
  readonly cancelled: boolean;
  readonly DataPart?: new (data: Uint8Array, mimeType: string) => T;
  readonly report: (part: T) => void;
}

/**
 * Report usage once, after a successful provider turn, when the user opts in.
 * Failure in this optional, unstable integration must never fail the chat.
 */
export function reportNativeChatUsage<T>(
  usage: OpenAIUsage | undefined,
  host: NativeChatUsageHost<T>,
): boolean {
  if (!host.enabled || host.cancelled || !supportsNativeChatUsage(host.version) || !host.DataPart) {
    return false;
  }

  const counts = normalizeNativeChatUsage(usage);
  if (!counts) {
    return false;
  }

  try {
    host.report(new host.DataPart(new TextEncoder().encode(JSON.stringify(counts)), "usage"));
    return true;
  } catch {
    // The undocumented response part may be rejected on any future host.
    return false;
  }
}
