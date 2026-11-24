/**
 * Bounded numeric settings for inline completions (#205).
 *
 * Kept free of `vscode` imports so the provider can read the settings and unit
 * tests can cover the clamping without a VS Code host. An absent, non-integer,
 * non-finite, or out-of-range value silently falls back to the default, so a
 * hand-edited setting never breaks completion or raises a notification.
 */

/** Generation budget used when `nanBuilders.completionMaxTokens` is unset. */
export const DEFAULT_COMPLETION_MAX_TOKENS = 64;
export const MIN_COMPLETION_MAX_TOKENS = 16;
export const MAX_COMPLETION_MAX_TOKENS = 512;

/** Quiet period used when `nanBuilders.completionDebounceMs` is unset. */
export const DEFAULT_COMPLETION_DEBOUNCE_MS = 150;
export const MIN_COMPLETION_DEBOUNCE_MS = 0;
export const MAX_COMPLETION_DEBOUNCE_MS = 2000;

/** Clamps `nanBuilders.completionMaxTokens` into its supported range. */
export function resolveCompletionMaxTokens(value: unknown): number {
  return resolveBoundedInteger(
    value,
    DEFAULT_COMPLETION_MAX_TOKENS,
    MIN_COMPLETION_MAX_TOKENS,
    MAX_COMPLETION_MAX_TOKENS,
  );
}

/** Clamps `nanBuilders.completionDebounceMs` into its supported range. */
export function resolveCompletionDebounceMs(value: unknown): number {
  return resolveBoundedInteger(
    value,
    DEFAULT_COMPLETION_DEBOUNCE_MS,
    MIN_COMPLETION_DEBOUNCE_MS,
    MAX_COMPLETION_DEBOUNCE_MS,
  );
}

function resolveBoundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return fallback;
  }
  return value;
}
