import assert from "node:assert/strict";
import test from "node:test";
import {
  activeProfileName,
  buildProfilePickItems,
  profileFromPick,
  statusBarProfileLabel,
} from "../src/profilePicker";

const TWO_PROFILES = ["personal", "work"];

test("buildProfilePickItems lists configured profiles in settings order", () => {
  const items = buildProfilePickItems(TWO_PROFILES, "personal");
  assert.deepEqual(
    items.map((item) => item.profileId),
    ["personal", "work"],
  );
  assert.deepEqual(
    items.map((item) => item.label),
    ["personal", "work"],
  );
});

test("buildProfilePickItems marks the active profile, and only that one", () => {
  const items = buildProfilePickItems(TWO_PROFILES, "work");
  assert.equal(items[0].description, undefined);
  assert.equal(items[0].detail, undefined);
  assert.equal(items[1].description, "$(checkmark) active profile");
  assert.match(items[1].detail ?? "", /profile::model/);
});

test("buildProfilePickItems marks the first profile when activeProfile is empty or stale", () => {
  for (const activeProfile of ["", "deleted-profile"]) {
    const items = buildProfilePickItems(TWO_PROFILES, activeProfile);
    assert.equal(items[0].description, "$(checkmark) active profile");
    assert.equal(items[1].description, undefined);
  }
});

test("buildProfilePickItems drops invalid and duplicate ids", () => {
  const items = buildProfilePickItems([" personal ", "personal", "bad profile", "", "work"], "work");
  assert.deepEqual(
    items.map((item) => item.profileId),
    ["personal", "work"],
  );
  assert.equal(items[1].description, "$(checkmark) active profile");
});

test("buildProfilePickItems returns no rows without profiles", () => {
  assert.deepEqual(buildProfilePickItems([], "personal"), []);
});

test("profileFromPick distinguishes dismissal from a selected profile", () => {
  assert.equal(profileFromPick(undefined), undefined);
  assert.equal(profileFromPick({ profileId: "work", label: "work" }), "work");
});

test("statusBarProfileLabel shows a name only when more than one profile is configured", () => {
  assert.equal(statusBarProfileLabel([], ""), undefined);
  assert.equal(statusBarProfileLabel(["personal"], "personal"), undefined);
  assert.equal(statusBarProfileLabel(TWO_PROFILES, "work"), "work");
  assert.equal(statusBarProfileLabel(TWO_PROFILES, ""), "personal");
  assert.equal(statusBarProfileLabel(TWO_PROFILES, "deleted-profile"), "personal");
});

test("activeProfileName resolves the serving profile for the tooltip", () => {
  assert.equal(activeProfileName([], ""), undefined);
  assert.equal(activeProfileName(["personal"], ""), "personal");
  assert.equal(activeProfileName(TWO_PROFILES, "work"), "work");
  assert.equal(activeProfileName(TWO_PROFILES, "deleted-profile"), "personal");
});
