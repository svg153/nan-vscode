import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureDiagnosticFile, diagnostic } from "../src/diagnostics";
import { collectDiagnostics, selectHostModels } from "../src/providerDiagnostics";
import {
  AUTO_EFFORT,
  PROFILE_SECRET_PREFIX,
  assignModelToProfile,
  assignedProfileForModel,
  describeRoute,
  effortOverride,
  isValidProfileId,
  nextActiveProfile,
  normalizeProfileIds,
  parseProfileModelAssignment,
  parseProfileSecretName,
  profileKeyPresence,
  profileSecretName,
  readConfiguredCredential,
  removeModelAssignment,
  removeProfileAssignments,
  renameProfileAssignments,
  resolveActiveProfile,
  resolveModelRoute,
  resolveModelRouteCandidates,
} from "../src/profiles";

const SENTINEL_KEY = "sk-profile-SENTINEL-6d1a9";

/** Two profiles as the acceptance criterion describes them: work and personal. */
const TWO_PROFILES = { profiles: ["personal", "work"], activeProfile: "personal" };

function stubSettings(values: Record<string, unknown> = {}) {
  return {
    get<T>(key: string, defaultValue: T): T {
      return (values[key] as T | undefined) ?? defaultValue;
    },
  };
}

test("assigning work::glm5.3 routes that model to the work key and everything else to the active profile", () => {
  const overrides = assignModelToProfile({}, "work", "glm5.3");

  assert.deepEqual(resolveModelRoute(TWO_PROFILES, overrides, "glm5.3"), {
    profileId: "work",
    source: "assignment",
  });
  assert.deepEqual(resolveModelRoute(TWO_PROFILES, overrides, "gemma4"), {
    profileId: "personal",
    source: "active",
  });
  assert.deepEqual(resolveModelRoute(TWO_PROFILES, overrides, "glm5.3-flash"), {
    profileId: "personal",
    source: "active",
  });
  // Routing alone never changes the reasoning effort of the assigned model.
  assert.equal(effortOverride(overrides, "glm5.3", "work"), undefined);
  assert.equal(overrides["work::glm5.3"], AUTO_EFFORT);
});

test("failover candidates put the routed profile first and keep settings order after it", () => {
  const threeProfiles = { profiles: ["personal", "work", "spare"], activeProfile: "personal" };
  const overrides = assignModelToProfile({}, "work", "glm5.3");

  assert.deepEqual(resolveModelRouteCandidates(threeProfiles, overrides, "glm5.3"), [
    { profileId: "work", source: "assignment" },
    { profileId: "personal", source: "failover" },
    { profileId: "spare", source: "failover" },
  ]);
  // Without an assignment the active profile leads and the rest follow.
  assert.deepEqual(resolveModelRouteCandidates(threeProfiles, overrides, "gemma4"), [
    { profileId: "personal", source: "active" },
    { profileId: "work", source: "failover" },
    { profileId: "spare", source: "failover" },
  ]);
  // A stale active profile falls back to the first id, exactly like the route.
  assert.deepEqual(
    resolveModelRouteCandidates({ profiles: ["personal", "work"], activeProfile: "gone" }, {}, "glm5.3").map(
      (route) => route.source,
    ),
    ["first", "failover"],
  );
  // One profile, or none, yields exactly the route `resolveModelRoute` picks.
  assert.deepEqual(resolveModelRouteCandidates({ profiles: ["work"] }, {}, "glm5.3"), [
    { profileId: "work", source: "first" },
  ]);
  assert.deepEqual(resolveModelRouteCandidates({ profiles: [] }, {}, "glm5.3"), [{ source: "legacy" }]);
});

test("without profiles the legacy shared key keeps serving every model", () => {
  const overrides = { "work::glm5.3": "high", "glm5.3": "low" };

  assert.deepEqual(resolveModelRoute({ profiles: [], activeProfile: "work" }, overrides, "glm5.3"), {
    source: "legacy",
  });
  assert.equal(resolveActiveProfile({ profiles: [] }), undefined);
  // A leftover plain override still applies: nothing about the legacy path moved.
  assert.equal(effortOverride(overrides, "glm5.3"), "low");
});

test("a deleted profile stops serving requests even if an override survives", () => {
  const withWork = assignModelToProfile({ "gemma4": "low" }, "work", "glm5.3");
  const afterDelete = removeProfileAssignments(withWork, "work");

  assert.deepEqual(afterDelete, { gemma4: "low" });
  // Profiles list no longer names work: the stale assignment is ignored, and a
  // route that still sees it cannot resolve a key for a removed profile.
  const remaining = { profiles: ["personal"], activeProfile: "personal" };
  assert.equal(assignedProfileForModel(withWork, "glm5.3", remaining.profiles), undefined);
  assert.deepEqual(resolveModelRoute(remaining, withWork, "glm5.3"), {
    profileId: "personal",
    source: "active",
  });
  assert.equal(nextActiveProfile(remaining.profiles, "work"), "personal");
});

test("deleting the last profile falls back to the shared key", () => {
  const afterDelete = removeProfileAssignments({ "work::glm5.3": "auto" }, "work");

  assert.deepEqual(afterDelete, {});
  assert.deepEqual(resolveModelRoute({ profiles: [] }, afterDelete, "glm5.3"), { source: "legacy" });
  assert.equal(nextActiveProfile([], "work"), "");
});

test("a model routes to exactly one profile, so assigning it again replaces the old entry", () => {
  const first = assignModelToProfile({ "glm5.3": "high" }, "work", "glm5.3");
  const second = assignModelToProfile(first, "personal", "glm5.3", "low");

  assert.deepEqual(second, { "glm5.3": "high", "personal::glm5.3": "low" });
  assert.equal(assignedProfileForModel(second, "glm5.3", ["personal", "work"]), "personal");
  assert.deepEqual(removeModelAssignment(second, "glm5.3"), { "glm5.3": "high" });
});

test("renaming a profile moves its assignments and keeps unrelated entries", () => {
  const before = { "work::glm5.3": "auto", "work::gemma4": "low", "personal::gpt-4o": "high", "gemma4": "minimal" };
  const after = renameProfileAssignments(before, "work", "office");

  assert.deepEqual(after, {
    "office::glm5.3": "auto",
    "office::gemma4": "low",
    "personal::gpt-4o": "high",
    "gemma4": "minimal",
  });
  assert.deepEqual(resolveModelRoute({ profiles: ["personal", "office"], activeProfile: "personal" }, after, "gemma4"), {
    profileId: "office",
    source: "assignment",
  });
});

test("composite effort wins over the plain entry; auto and non-string values mean no override", () => {
  const overrides = { "glm5.3": "high", "work::glm5.3": "low", "work::gemma4": AUTO_EFFORT, "work::qwen": 3 };

  assert.equal(effortOverride(overrides, "glm5.3", "work"), "low");
  assert.equal(effortOverride(overrides, "glm5.3", "personal"), "high");
  assert.equal(effortOverride(overrides, "gemma4", "work"), undefined);
  assert.equal(effortOverride(overrides, "qwen", "work"), undefined);
  assert.equal(effortOverride(undefined, "glm5.3", "work"), undefined);
});

test("active profile falls back to the first id when the setting is empty or stale", () => {
  assert.equal(resolveActiveProfile({ profiles: ["personal", "work"] }), "personal");
  assert.equal(resolveActiveProfile({ profiles: ["personal", "work"], activeProfile: "  " }), "personal");
  assert.equal(resolveActiveProfile({ profiles: ["personal", "work"], activeProfile: "gone" }), "personal");
  assert.equal(resolveActiveProfile({ profiles: ["personal", "work"], activeProfile: "work" }), "work");

  const unset = resolveModelRoute({ profiles: ["personal", "work"] }, {}, "glm5.3");
  assert.deepEqual(unset, { profileId: "personal", source: "first" });
});

test("profile ids are validated and normalized so SecretStorage names stay unambiguous", () => {
  assert.equal(isValidProfileId("work"), true);
  assert.equal(isValidProfileId("team.eu-1_x"), true);
  assert.equal(isValidProfileId(""), false);
  assert.equal(isValidProfileId("-work"), false);
  assert.equal(isValidProfileId("work personal"), false);
  assert.equal(isValidProfileId("x".repeat(33)), false);
  assert.equal(isValidProfileId(42), false);

  assert.deepEqual(normalizeProfileIds([" work ", "work", "", "-bad", 7, "personal"]), ["work", "personal"]);
  assert.deepEqual(normalizeProfileIds("work"), []);

  assert.equal(profileSecretName("work"), `${PROFILE_SECRET_PREFIX}work`);
  assert.equal(
    profileSecretName("work"),
    "nanBuilders.profileKey.work",
    "the documented SecretStorage name is a compatibility contract",
  );
  assert.equal(parseProfileSecretName("nanBuilders.profileKey.work"), "work");
  assert.equal(parseProfileSecretName("nanBuilders.apiKey"), undefined);
  assert.equal(parseProfileSecretName("nanBuilders.profileKey.bad id"), undefined);
});

test("override keys split into profile and model halves, and plain keys stay plain", () => {
  assert.deepEqual(parseProfileModelAssignment("work::glm5.3"), { profileId: "work", modelId: "glm5.3" });
  assert.deepEqual(parseProfileModelAssignment("work::openai/gpt-4o"), {
    profileId: "work",
    modelId: "openai/gpt-4o",
  });
  assert.equal(parseProfileModelAssignment("glm5.3"), undefined);
  assert.equal(parseProfileModelAssignment("::glm5.3"), undefined);
  assert.equal(parseProfileModelAssignment("work::"), undefined);
  assert.equal(parseProfileModelAssignment("bad id::glm5.3"), undefined);
});

test("readConfiguredCredential prefers the active profile and falls back to the legacy key", async () => {
  const stored = new Map([[profileSecretName("work"), SENTINEL_KEY], ["nanBuilders.apiKey", "legacy"]]);
  const readSecret = async (name: string) => stored.get(name);

  assert.deepEqual(await readConfiguredCredential(TWO_PROFILES, readSecret, "nanBuilders.apiKey"), {
    apiKey: undefined,
    profileId: "personal",
  });
  assert.deepEqual(
    await readConfiguredCredential({ profiles: ["personal", "work"], activeProfile: "work" }, readSecret, "nanBuilders.apiKey"),
    { apiKey: SENTINEL_KEY, profileId: "work" },
  );
  assert.deepEqual(await readConfiguredCredential({ profiles: [] }, readSecret, "nanBuilders.apiKey"), {
    apiKey: "legacy",
    profileId: undefined,
  });
  // A sync reader (the VS Code Test API style stub) is accepted too.
  assert.deepEqual(
    await readConfiguredCredential({ profiles: ["work"] }, (name) => stored.get(name), "nanBuilders.apiKey"),
    { apiKey: SENTINEL_KEY, profileId: "work" },
  );
});

test("key presence is reported from secret names only", () => {
  const presence = profileKeyPresence(
    ["personal", "work"],
    ["nanBuilders.apiKey", profileSecretName("work")],
  );

  assert.deepEqual(presence, [
    { profileId: "personal", hasKey: false },
    { profileId: "work", hasKey: true },
  ]);
});

test("diagnostics report lists profile ids and key presence but never a key value", async () => {
  const overrides = assignModelToProfile({}, "work", "glm5.3");
  const markdown = collectDiagnostics({
    generatedAt: "2026-11-16T22:00:00.000Z",
    extensionVersion: "1.5.1",
    vscodeVersion: "1.104.0",
    baseUrl: "https://api.nan.builders/v1",
    configuration: stubSettings(),
    hostModels: await selectHostModels(
      { selectChatModels: async () => [{ id: "glm5.3", vendor: "nan-builders", maxInputTokens: 1_000 }] },
      "nan-builders",
    ),
    secretKeys: [profileSecretName("work"), profileSecretName("personal")],
    // The sentinel stands in for a stored profile key; the report only ever
    // sees secret *names*, so it can never print the value.
    profiles: ["personal", "work"],
    activeProfile: "personal",
    profileAssignments: Object.keys(overrides).map((key) => parseProfileModelAssignment(key)!),
    trackedModels: ["glm5.3"],
  });

  assert.match(markdown, /## Profiles/);
  assert.match(markdown, /- Active profile: `personal`/);
  assert.match(markdown, /- `work`: key configured/);
  assert.match(markdown, /- `personal` \(active\): key configured/);
  assert.match(markdown, /- `glm5\.3` → profile `work`/);
  assert.doesNotMatch(markdown, /SENTINEL/);
  assert.doesNotMatch(markdown, new RegExp(profileSecretName("work")));
});

test("diagnostics report explains the shared-key path when no profile is configured", async () => {
  const markdown = collectDiagnostics({
    extensionVersion: "1.5.1",
    vscodeVersion: "1.104.0",
    baseUrl: "https://api.nan.builders/v1",
    configuration: stubSettings(),
    hostModels: await selectHostModels({ selectChatModels: async () => [] }, "nan-builders"),
    secretKeys: ["nanBuilders.apiKey"],
    profiles: [],
    trackedModels: [],
  });

  assert.match(markdown, /- No profiles configured: every model uses the shared `nanBuilders\.apiKey` key\./);
  assert.match(markdown, /- Add profiles in \*\*NaN Builders: Manage Provider\*\*/);
});

test("credential diagnostics events carry the profile id and key presence, never the key", () => {
  const directory = mkdtempSync(join(tmpdir(), "nan-vscode-profiles-"));
  const file = join(directory, "nan-vscode-diagnostics.log");
  const output: string[] = [];
  const channel = { appendLine: (line: string) => output.push(line) };

  try {
    configureDiagnosticFile(directory, true, channel);
    const route = resolveModelRoute(TWO_PROFILES, { "work::glm5.3": AUTO_EFFORT }, "glm5.3");
    diagnostic("chat.credential", { modelId: "glm5.3", ...describeRoute(route), hasKey: true });
    diagnostic("inline.credential", { model: "glm5.3", ...describeRoute(route), hasKey: false });

    const written = readFileSync(file, "utf8");
    assert.match(written, /"profile":"work"/);
    assert.match(written, /"profileSource":"assignment"/);
    assert.match(written, /"hasKey":true/);
    assert.doesNotMatch(written, /SENTINEL/);
    assert.deepEqual(describeRoute(route), { profile: "work", profileSource: "assignment" });
    // The legacy path is named without inventing a profile id.
    assert.deepEqual(describeRoute({ source: "legacy" }), { profile: "(shared key)", profileSource: "legacy" });
  } finally {
    configureDiagnosticFile(directory, false, channel);
    rmSync(directory, { recursive: true, force: true });
  }
});
