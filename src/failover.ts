/**
 * Opt-in failover from a throttled profile key to another own profile (#144).
 *
 * Kept free of the `vscode` module so the whole policy is unit-testable:
 * candidate order, the single hop, the exclusive throttle trigger, and the
 * per-key cooldown. Keys never enter this module: a caller resolves a
 * candidate to an opaque {@link ResolvedCredential} whose `credentialId` is the
 * same truncated SHA-256 fingerprint the slot queues use, so two profiles that
 * share one key also share one cooldown.
 *
 * The default stays fixed routing: with the setting off, one attempt is made
 * with the key `resolveModelRoute` chose and its error propagates unchanged.
 */

import { ProviderError } from "./providerErrors";

/** Boolean setting that turns the opt-in failover on. Off by default. */
export const FAILOVER_SETTING = "failoverOnThrottle";
/** `Retry-After` is used when present; otherwise the key cools down this long. */
export const DEFAULT_COOLDOWN_SECONDS = 60;
/** Upper bound, so a hostile or mistaken header cannot bench a key for a day. */
export const MAX_COOLDOWN_SECONDS = 300;
/** Label used for the legacy shared key, which has no profile id. */
export const SHARED_KEY_LABEL = "(shared key)";

/** One-time warning shown when the setting is first enabled. */
export const FAILOVER_WARNING =
  "NaN Builders failover on throttle is on: when a profile's key is rate limited, one chat request is " +
  "retried with the next profile that has its own key. Use this only with accounts you own and pay for. " +
  "NaN issues every member a personal, non-transferable key, and several keys do not pool into a larger " +
  "allowance; trying to exceed the published limits risks a revoked key and forfeited credits.";

/** Cooldown state reported by *Show Diagnostics*; ids only, never a key. */
export interface FailoverDiagnostics {
  readonly enabled: boolean;
  readonly cooling: ReadonlyArray<{ readonly profileId?: string; readonly remainingSeconds: number }>;
}

/** A profile a request may use, in candidate order. `profileId` absent = shared key. */
export interface FailoverCandidate {
  readonly profileId?: string;
}

/** A candidate whose key the caller read from SecretStorage. */
export interface ResolvedCredential {
  /** Fingerprint of the key, shared by every profile that stores the same key. */
  readonly credentialId: string;
}

/** Details of a hop, already reduced to ids so it is safe to log. */
export interface FailoverHop<C extends FailoverCandidate> {
  readonly from: C;
  readonly to: C;
  readonly reason: "rate_limit_exceeded";
  readonly cooldownSeconds: number;
}

export interface FailoverPlan<C extends FailoverCandidate, R extends ResolvedCredential> {
  /** `nanBuilders.failoverOnThrottle`. False keeps fixed routing. */
  readonly enabled: boolean;
  /**
   * Ordered candidates: the route `resolveModelRoute` chose first, then the
   * remaining configured profiles in settings order.
   */
  readonly candidates: readonly C[];
  /**
   * Reads one candidate's key. `undefined` means the profile has no key, so it
   * is not a candidate at all. A rejection skips that profile instead of
   * failing a request another key could still serve.
   */
  resolve(candidate: C): Promise<R | undefined>;
  /** Called right before a hop, with ids and the cooldown applied. */
  onHop?(hop: FailoverHop<C>): void;
  /** Clock override for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface FailoverSuccess<C extends FailoverCandidate, T> {
  readonly value: T;
  /** Candidate that served the request. */
  readonly used: C;
  /** Every candidate the request actually reached, in order. */
  readonly attempted: readonly C[];
  /** True when the request succeeded on a hop instead of the first key. */
  readonly hopped: boolean;
}

/** `nanBuilders.failoverOnThrottle` is on only when the value is exactly `true`. */
export function resolveFailoverEnabled(value: unknown): boolean {
  return value === true;
}

/** True while the one-time own-accounts warning still has to be shown. */
export function failoverWarningPending(enabled: unknown, acknowledged: boolean): boolean {
  return resolveFailoverEnabled(enabled) && !acknowledged;
}

/** How one candidate is named in errors and diagnostics. */
export function profileLabel(profileId: string | undefined): string {
  return profileId ?? SHARED_KEY_LABEL;
}

/**
 * A throttle is retried only when `src/providerErrors.ts` classified the
 * failure as `rate_limit_exceeded`. Status codes are deliberately not inspected:
 * a 429 that reports exhausted credits is `insufficient_quota`, and 401/403 are
 * `invalid_api_key`; hopping on those would hide a configuration or billing
 * problem instead of relieving a limit.
 */
export function isThrottleError(error: unknown): error is ProviderError {
  return error instanceof ProviderError && error.code === "rate_limit_exceeded";
}

/**
 * Cooldown applied to a throttled key: the gateway's `Retry-After` when it is
 * present, otherwise {@link DEFAULT_COOLDOWN_SECONDS}, never below one second
 * and never above {@link MAX_COOLDOWN_SECONDS}.
 */
export function cooldownSeconds(
  error: unknown,
  fallbackSeconds: number = DEFAULT_COOLDOWN_SECONDS,
): number {
  const retryAfter = error instanceof ProviderError ? error.retryAfterSeconds : undefined;
  const requested =
    typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter
      : fallbackSeconds;
  return Math.min(MAX_COOLDOWN_SECONDS, Math.max(1, Math.ceil(requested)));
}

/** `Profiles tried: work, personal.` — ids only, sharing one message format. */
export function profilesTriedSuffix(candidates: readonly FailoverCandidate[]): string {
  const labels = candidates.map((candidate) => profileLabel(candidate.profileId));
  return labels.length > 0 ? ` Profiles tried: ${labels.join(", ")}.` : "";
}

/**
 * Appends the ids of the profiles the request reached to the original error,
 * leaving its classification and message intact. The original object is
 * returned whenever appending is not possible, so callers keep the cause.
 */
export function appendProfilesTried<T>(
  error: T,
  candidates: readonly FailoverCandidate[],
): T {
  const suffix = profilesTriedSuffix(candidates);
  if (!suffix || !(error instanceof Error) || error.message.includes("Profiles tried:")) {
    return error;
  }
  error.message = `${error.message}${suffix}`;
  return error;
}

/**
 * Cooldown per credential fingerprint. Expired entries are dropped on read, so
 * the map is bounded by the number of keys that were throttled recently.
 */
export class ThrottleCooldowns {
  private readonly entries = new Map<string, { profileId?: string; expiresAt: number }>();

  /** Applies a cooldown; a longer remaining window always wins. */
  note(credentialId: string, seconds: number, profileId: string | undefined, now: number): void {
    const expiresAt = now + Math.max(1, Math.ceil(seconds)) * 1_000;
    const existing = this.entries.get(credentialId);
    if (existing && existing.expiresAt >= expiresAt) {
      return;
    }
    this.entries.set(credentialId, { profileId, expiresAt });
  }

  /** True while `credentialId` is benched. Expired entries are removed here. */
  isCooling(credentialId: string, now: number): boolean {
    const entry = this.entries.get(credentialId);
    if (!entry) {
      return false;
    }
    if (entry.expiresAt <= now) {
      this.entries.delete(credentialId);
      return false;
    }
    return true;
  }

  /** Whole seconds left, at least one while cooling; `0` when the key is free. */
  remainingSeconds(credentialId: string, now: number): number {
    const entry = this.entries.get(credentialId);
    if (!entry) {
      return 0;
    }
    if (entry.expiresAt <= now) {
      this.entries.delete(credentialId);
      return 0;
    }
    return Math.max(1, Math.ceil((entry.expiresAt - now) / 1_000));
  }

  /** Diagnostics-safe snapshot: profile ids and whole seconds, never a key. */
  snapshot(now: number): Array<{ profileId?: string; remainingSeconds: number }> {
    const cooled: Array<{ profileId?: string; remainingSeconds: number }> = [];
    for (const [credentialId, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(credentialId);
        continue;
      }
      cooled.push({ profileId: entry.profileId, remainingSeconds: Math.max(1, Math.ceil((entry.expiresAt - now) / 1_000)) });
    }
    return cooled;
  }

  /** Forgets every cooldown; used when the window reloads its settings. */
  clear(): void {
    this.entries.clear();
  }
}

/**
 * Runs one request under the failover policy.
 *
 * With the setting off, or with a single candidate, this is exactly one
 * attempt and the error propagates untouched. With it on, the routed key is
 * still tried first — routing stays fixed — and only a `rate_limit_exceeded`
 * failure benches that key and retries once on the next profile that has its
 * own key and is not cooling down. A request never chains more than that one
 * hop. When no profile can serve the hop the original error is propagated with
 * the ids of the profiles the request considered, so nothing is rewritten.
 */
export async function runWithFailover<C extends FailoverCandidate, R extends ResolvedCredential, T>(
  plan: FailoverPlan<C, R>,
  cooldowns: ThrottleCooldowns,
  attempt: (candidate: C, credential: R, index: number) => Promise<T>,
): Promise<FailoverSuccess<C, T>> {
  const primary = plan.candidates[0];
  if (!primary) {
    throw new Error("NaN Builders failover needs at least one profile candidate.");
  }
  const now = plan.now ?? Date.now;
  const policy = plan.enabled && plan.candidates.length > 1;

  // A candidate with no stored key is not a candidate at all, and an unreadable
  // secret skips that profile instead of failing a request another key serves.
  const resolveCandidate = async (candidate: C): Promise<R | undefined> => {
    try {
      return await plan.resolve(candidate);
    } catch {
      return undefined;
    }
  };

  const primaryCredential = await resolveCandidate(primary);
  if (!primaryCredential) {
    throw new Error("No NaN Builders API key is available for this request.");
  }

  let primaryError: unknown;
  try {
    return {
      value: await attempt(primary, primaryCredential, 0),
      used: primary,
      attempted: [primary],
      hopped: false,
    };
  } catch (error) {
    if (!policy || !isThrottleError(error)) {
      throw error;
    }
    primaryError = error;
    cooldowns.note(primaryCredential.credentialId, cooldownSeconds(error), primary.profileId, now());
  }

  // One hop, and only to a profile that has its own key and is not itself
  // cooling down. Keys are resolved lazily so the healthy path never reads a
  // second secret.
  const considered: C[] = [primary];
  let hop: { candidate: C; credential: R } | undefined;
  for (let index = 1; index < plan.candidates.length && !hop; index += 1) {
    const candidate = plan.candidates[index];
    // oxlint-disable-next-line eslint/no-await-in-loop
    const credential = await resolveCandidate(candidate);
    if (!credential) {
      continue;
    }
    considered.push(candidate);
    if (cooldowns.isCooling(credential.credentialId, now())) {
      continue;
    }
    hop = { candidate, credential };
  }
  if (!hop) {
    throw appendProfilesTried(primaryError, considered);
  }

  plan.onHop?.({
    from: primary,
    to: hop.candidate,
    reason: "rate_limit_exceeded",
    cooldownSeconds: cooldownSeconds(primaryError),
  });
  try {
    return {
      value: await attempt(hop.candidate, hop.credential, 1),
      used: hop.candidate,
      attempted: [primary, hop.candidate],
      hopped: true,
    };
  } catch (hopError) {
    // A second throttle ends the request here: one hop is the whole policy, so
    // the error is propagated with the ids of both profiles that were tried.
    if (isThrottleError(hopError)) {
      cooldowns.note(hop.credential.credentialId, cooldownSeconds(hopError), hop.candidate.profileId, now());
    }
    throw appendProfilesTried(hopError, [primary, hop.candidate]);
  }
}
