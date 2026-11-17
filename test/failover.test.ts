import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_COOLDOWN_SECONDS,
  MAX_COOLDOWN_SECONDS,
  ThrottleCooldowns,
  appendProfilesTried,
  cooldownSeconds,
  failoverWarningPending,
  isThrottleError,
  profilesTriedSuffix,
  profileLabel,
  resolveFailoverEnabled,
  runWithFailover,
  type FailoverCandidate,
  type FailoverHop,
  type FailoverPlan,
} from "../src/failover";
import { credentialId } from "../src/openai/slotQueue";
import { ProviderError, httpError } from "../src/providerErrors";

/**
 * Stands in for a stored key. It is never a real key, and no error or
 * diagnostic produced by the failover may contain it.
 */
const SENTINEL_KEY = "sk-live-SENTINEL-8f4c2b";

interface Candidate extends FailoverCandidate {
  readonly profileId?: string;
}

interface Credential {
  readonly credentialId: string;
  readonly apiKey: string;
}

interface ProfileStub {
  readonly profileId?: string;
  /** Absent means the profile has no key in SecretStorage. */
  readonly key?: string;
}

/** Plan over stub profiles, with the secrets resolved the way the provider does. */
function makePlan(
  profiles: readonly ProfileStub[],
  options: {
    enabled?: boolean;
    now?: () => number;
    onHop?: (hop: FailoverHop<Candidate>) => void;
    resolved?: Candidate[];
  } = {},
): FailoverPlan<Candidate, Credential> {
  const candidates: Candidate[] = profiles.map((profile) => ({ profileId: profile.profileId }));
  const resolved = options.resolved;
  return {
    enabled: options.enabled ?? true,
    candidates,
    resolve: async (candidate) => {
      const profile = profiles[candidates.indexOf(candidate)];
      resolved?.push(candidate);
      return profile?.key ? { apiKey: profile.key, credentialId: credentialId(profile.key) } : undefined;
    },
    onHop: options.onHop,
    now: options.now,
  };
}

function throttle(retryAfterSeconds?: number): ProviderError {
  return new ProviderError({
    code: "rate_limit_exceeded",
    message: "NaN Builders rate limited this request. Retry in 30s.",
    retryable: true,
    retryAfterSeconds,
  });
}

/** Records which profile served each attempt, so "one hop" is countable. */
function recorder(errors: ReadonlyArray<unknown>): {
  attempt: (candidate: Candidate, credential: Credential, index: number) => Promise<string>;
  tried: Candidate[];
} {
  const tried: Candidate[] = [];
  return {
    tried,
    attempt: async (candidate) => {
      tried.push(candidate);
      const failure = errors[tried.length - 1];
      if (failure) {
        throw failure;
      }
      return `served by ${profileLabel(candidate.profileId)}`;
    },
  };
}

test("the setting is off unless it is exactly true", () => {
  for (const value of [undefined, null, false, 0, 1, "true", "false", {}, []]) {
    assert.equal(resolveFailoverEnabled(value), false, `${JSON.stringify(value)} must not enable failover`);
  }
  assert.equal(resolveFailoverEnabled(true), true);
});

test("with the setting off the routed key is the only key and its error is unchanged", async () => {
  const failure = throttle(30);
  const resolved: Candidate[] = [];
  const plan = makePlan([{ profileId: "personal", key: SENTINEL_KEY }, { profileId: "work", key: "sk-live-second" }], {
    enabled: false,
    resolved,
  });
  const { attempt, tried } = recorder([failure]);

  await assert.rejects(() => runWithFailover(plan, new ThrottleCooldowns(), attempt), (error) => {
    assert.equal(error, failure);
    assert.doesNotMatch((error as Error).message, /Profiles tried/);
    return true;
  });
  assert.deepEqual(tried.map((candidate) => candidate.profileId), ["personal"]);
  // No other profile's secret is even read, so no second key is attempted.
  assert.equal(resolved.length, 1);
});

test("only rate_limit_exceeded triggers a hop", async () => {
  const cases: Array<unknown> = [
    httpError(402, "Payment Required", '{"error":{"code":"insufficient_quota"}}'),
    httpError(429, "Too Many Requests", '{"error":{"code":"insufficient_quota","type":"insufficient_quota"}}'),
    httpError(401, "Unauthorized", '{"error":{"code":"invalid_api_key"}}'),
    httpError(404, "Not Found", '{"error":{"code":"model_not_found"}}'),
    httpError(400, "Bad Request", '{"error":{"code":"context_length_exceeded"}}'),
    new ProviderError({ code: "timeout", message: "NaN Builders timed out.", retryable: true }),
    new ProviderError({ code: "network", message: "NaN Builders could not be reached.", retryable: true }),
    new ProviderError({ code: "cancelled", message: "The request was cancelled.", retryable: false }),
    new Error("plain failure"),
  ];

  for (const failure of cases) {
    const plan = makePlan([
      { profileId: "personal", key: SENTINEL_KEY },
      { profileId: "work", key: "sk-live-second" },
    ]);
    const { attempt, tried } = recorder([failure]);
    await assert.rejects(() => runWithFailover(plan, new ThrottleCooldowns(), attempt), (error) => {
      assert.equal(error, failure);
      return true;
    });
    assert.equal(tried.length, 1, `${failure} must not hop`);
    assert.equal(isThrottleError(failure), false);
  }
});

test("a throttled key is retried once on the next profile and the hop carries ids only", async () => {
  const hops: Array<FailoverHop<Candidate>> = [];
  const plan = makePlan(
    [
      { profileId: "personal", key: SENTINEL_KEY },
      { profileId: "work", key: "sk-live-second" },
      { profileId: "spare", key: "sk-live-third" },
    ],
    { onHop: (hop) => hops.push(hop) },
  );
  const { attempt, tried } = recorder([throttle(45)]);

  const result = await runWithFailover(plan, new ThrottleCooldowns(), attempt);
  assert.equal(result.hopped, true);
  assert.equal(result.used.profileId, "work");
  assert.deepEqual(result.attempted.map((candidate) => candidate.profileId), ["personal", "work"]);
  assert.deepEqual(tried.map((candidate) => candidate.profileId), ["personal", "work"]);
  assert.deepEqual(hops, [
    {
      from: { profileId: "personal" },
      to: { profileId: "work" },
      reason: "rate_limit_exceeded",
      cooldownSeconds: 45,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(hops), /SENTINEL/);
});

test("a request never chains more than one hop and the final error names the profiles", async () => {
  const hops: Array<FailoverHop<Candidate>> = [];
  const plan = makePlan(
    [
      { profileId: "personal", key: SENTINEL_KEY },
      { profileId: "work", key: "sk-live-second" },
      { profileId: "spare", key: "sk-live-third" },
    ],
    { onHop: (hop) => hops.push(hop) },
  );
  const second = throttle(20);
  const { attempt, tried } = recorder([throttle(20), second]);

  await assert.rejects(() => runWithFailover(plan, new ThrottleCooldowns(), attempt), (error) => {
    assert.equal(error, second);
    assert.match((error as Error).message, /Profiles tried: personal, work\.$/);
    assert.doesNotMatch((error as Error).message, /SENTINEL/);
    return true;
  });
  assert.deepEqual(tried.map((candidate) => candidate.profileId), ["personal", "work"]);
  assert.equal(hops.length, 1);
});

test("every candidate in cooldown propagates the original error with the ids", async () => {
  const cooldowns = new ThrottleCooldowns();
  const startedAt = Date.now();
  // The only other profile is already benched by an earlier request.
  cooldowns.note(credentialId("sk-live-second"), 60, "work", startedAt);
  const failure = throttle(30);
  const plan = makePlan([
    { profileId: "personal", key: SENTINEL_KEY },
    { profileId: "work", key: "sk-live-second" },
  ]);
  const { attempt, tried } = recorder([failure]);

  await assert.rejects(() => runWithFailover(plan, cooldowns, attempt), (error) => {
    assert.equal(error, failure);
    assert.match((error as Error).message, /Profiles tried: personal, work\.$/);
    return true;
  });
  // Only the routed key was actually called; the hop was refused by the cooldown.
  assert.deepEqual(tried.map((candidate) => candidate.profileId), ["personal"]);

  const cooling = cooldowns.snapshot(Date.now());
  assert.deepEqual(
    cooling.map((entry) => entry.profileId),
    ["work", "personal"],
  );
});

test("the cooldown honors Retry-After, defaults to 60s, and is capped", () => {
  assert.equal(cooldownSeconds(throttle(120)), 120);
  assert.equal(cooldownSeconds(throttle()), DEFAULT_COOLDOWN_SECONDS);
  assert.equal(cooldownSeconds(new Error("no classification")), DEFAULT_COOLDOWN_SECONDS);
  assert.equal(cooldownSeconds(throttle(90_000)), MAX_COOLDOWN_SECONDS);
  assert.equal(cooldownSeconds(throttle(0.2)), 1);

  const cooldowns = new ThrottleCooldowns();
  const id = credentialId(SENTINEL_KEY);
  cooldowns.note(id, 10, "personal", 1_000);
  assert.equal(cooldowns.isCooling(id, 1_000), true);
  assert.equal(cooldowns.remainingSeconds(id, 1_000), 10);
  assert.equal(cooldowns.remainingSeconds(id, 5_500), 6);
  // The window lapses and the key is a candidate again (AC "cooldown expirado").
  assert.equal(cooldowns.isCooling(id, 11_000), false);
  assert.equal(cooldowns.remainingSeconds(id, 11_000), 0);
  assert.deepEqual(cooldowns.snapshot(11_000), []);
});

test("a key in cooldown is skipped as a hop destination until its window lapses", async () => {
  let now = 1_000_000;
  const cooldowns = new ThrottleCooldowns();
  const plan = makePlan(
    [
      { profileId: "personal", key: SENTINEL_KEY },
      { profileId: "work", key: "sk-live-second" },
    ],
    { now: () => now },
  );

  // First request benches "work" for 30s after it also throttles.
  const first = recorder([throttle(30), throttle(30)]);
  await assert.rejects(() => runWithFailover(plan, cooldowns, first.attempt), /Profiles tried: personal, work/);
  assert.deepEqual(
    cooldowns.snapshot(now).map((entry) => entry.profileId),
    ["personal", "work"],
  );

  // While it cools down the hop is refused instead of hammering the same key.
  const during = recorder([throttle(30)]);
  await assert.rejects(() => runWithFailover(plan, cooldowns, during.attempt));
  assert.deepEqual(during.tried.map((candidate) => candidate.profileId), ["personal"]);

  // Once the window lapses the profile is a candidate again.
  now += 31_000;
  const after = recorder([throttle(30)]);
  const result = await runWithFailover(plan, cooldowns, after.attempt);
  assert.equal(result.hopped, true);
  assert.equal(result.used.profileId, "work");
});

test("two profiles sharing one key share one cooldown", async () => {
  const cooldowns = new ThrottleCooldowns();
  const plan = makePlan([
    { profileId: "personal", key: SENTINEL_KEY },
    { profileId: "duplicate", key: SENTINEL_KEY },
    { profileId: "work", key: "sk-live-second" },
  ]);
  const { attempt, tried } = recorder([throttle(30)]);

  const result = await runWithFailover(plan, cooldowns, attempt);
  // The duplicate holds the same key, so it must not be used as a hop target.
  assert.equal(result.used.profileId, "work");
  assert.deepEqual(tried.map((candidate) => candidate.profileId), ["personal", "work"]);
  assert.equal(cooldowns.snapshot(Date.now()).length, 1);
});

test("profiles without a stored key are not hop candidates", async () => {
  const plan = makePlan([
    { profileId: "personal", key: SENTINEL_KEY },
    { profileId: "keyless" },
    { profileId: "work", key: "sk-live-second" },
  ]);
  const { attempt, tried } = recorder([throttle(30)]);

  const result = await runWithFailover(plan, new ThrottleCooldowns(), attempt);
  assert.equal(result.used.profileId, "work");
  assert.deepEqual(tried.map((candidate) => candidate.profileId), ["personal", "work"]);
});

test("a single candidate is exactly one attempt and its error is untouched", async () => {
  const failure = throttle(30);
  const plan = makePlan([{ profileId: "personal", key: SENTINEL_KEY }]);
  const { attempt, tried } = recorder([failure]);

  await assert.rejects(() => runWithFailover(plan, new ThrottleCooldowns(), attempt), (error) => {
    assert.equal(error, failure);
    assert.doesNotMatch((error as Error).message, /Profiles tried/);
    return true;
  });
  assert.equal(tried.length, 1);
});

test("the cooldown snapshot never contains a key", async () => {
  let now = 2_000_000;
  const cooldowns = new ThrottleCooldowns();
  const plan = makePlan(
    [
      { profileId: "personal", key: SENTINEL_KEY },
      { profileId: "work", key: "sk-live-second" },
    ],
    { now: () => now },
  );
  const { attempt } = recorder([throttle(30), throttle(30)]);
  await assert.rejects(() => runWithFailover(plan, cooldowns, attempt), /Profiles tried: personal, work/);
  now += 5_000;

  const snapshot = cooldowns.snapshot(now);
  assert.deepEqual(snapshot, [
    { profileId: "personal", remainingSeconds: 25 },
    { profileId: "work", remainingSeconds: 25 },
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /SENTINEL/);
});

test("the own-accounts warning is offered once, on the first enable", () => {
  assert.equal(failoverWarningPending(false, false), false);
  assert.equal(failoverWarningPending(undefined, false), false);
  assert.equal(failoverWarningPending(true, false), true);
  assert.equal(failoverWarningPending(true, true), false);
});

test("the profiles-tried suffix uses ids only and never repeats", () => {
  assert.equal(profilesTriedSuffix([]), "");
  assert.equal(profileLabel(undefined), "(shared key)");
  assert.equal(
    profilesTriedSuffix([{ profileId: "personal" }, { profileId: "work" }]),
    " Profiles tried: personal, work.",
  );

  const error = new ProviderError({ code: "rate_limit_exceeded", message: "Rate limited.", retryable: true });
  const decorated = appendProfilesTried(error, [{ profileId: "personal" }]);
  assert.equal(decorated, error);
  assert.equal(decorated.message, "Rate limited. Profiles tried: personal.");
  assert.equal(decorated.code, "rate_limit_exceeded");
  // A second decoration is a no-op, so a wrapped error keeps one suffix.
  appendProfilesTried(decorated, [{ profileId: "work" }]);
  assert.equal(decorated.message, "Rate limited. Profiles tried: personal.");
  // Non-Error values keep their identity.
  const plain = "boom";
  assert.equal(appendProfilesTried(plain, [{ profileId: "personal" }]), plain);
});
