import assert from "node:assert/strict";
import test from "node:test";
import {
  MANAGE_PROVIDER_ACTION,
  MAX_REMEMBERED_VENDOR_CONFLICTS,
  SHOW_DIAGNOSTICS_ACTION,
  VENDOR_CONFLICT_NOTIFIED_KEY,
  announceVendorConflictOnce,
  detectVendorConflict,
  formatVendorConflictDiagnosticLine,
  formatVendorConflictMessage,
  vendorConflictDiagnosticDetails,
  vendorConflictSignature,
  type VendorConflict,
  type VendorConflictMemento,
} from "../src/vendorConflict";

const OWN_MODELS = ["nan-a", "nan-b"];

function createState(initial?: unknown): { state: VendorConflictMemento; values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  if (initial !== undefined) {
    values.set(VENDOR_CONFLICT_NOTIFIED_KEY, initial);
  }
  return {
    values,
    state: {
      get<T>(key: string, defaultValue: T): T {
        return (values.has(key) ? values.get(key) : defaultValue) as T;
      },
      update(key: string, value: unknown): Thenable<void> {
        values.set(key, value);
        return Promise.resolve();
      },
    },
  };
}

function conflictOf(observed: readonly string[], own: readonly string[] = OWN_MODELS): VendorConflict {
  const conflict = detectVendorConflict(observed, own);
  assert.ok(conflict, `expected a conflict for ${observed.join(",")}`);
  return conflict;
}

test("own models only never count as a conflict", () => {
  assert.equal(detectVendorConflict(OWN_MODELS, OWN_MODELS), undefined);
  assert.equal(detectVendorConflict(["nan-a"], OWN_MODELS), undefined);
  assert.equal(detectVendorConflict([], OWN_MODELS), undefined);
});

test("nothing published means nothing to compare, even when the host lists models", () => {
  assert.equal(detectVendorConflict(["nan-a", "foreign"], []), undefined);
  assert.equal(detectVendorConflict(["foreign"], []), undefined);
});

test("partial host answers that miss every own id are skipped", () => {
  assert.equal(detectVendorConflict(["foreign-1", "foreign-2"], OWN_MODELS), undefined);
});

test("models this extension never published are reported as foreign", () => {
  const conflict = conflictOf(["nan-a", "nan-b", "other-model"]);
  assert.equal(conflict.vendor, "nan-builders");
  assert.equal(conflict.observedModelCount, 3);
  assert.equal(conflict.ownModelCount, 2);
  assert.equal(conflict.foreignModelCount, 1);
  assert.deepEqual(conflict.foreignModelIds, ["other-model"]);
  assert.deepEqual(conflict.duplicateModelIds, []);
});

test("a duplicated own id is attributed to another provider", () => {
  const conflict = conflictOf(["nan-b", "nan-a", "nan-a"]);
  assert.equal(conflict.foreignModelCount, 1);
  assert.deepEqual(conflict.foreignModelIds, ["nan-a"]);
  assert.deepEqual(conflict.duplicateModelIds, ["nan-a"]);
});

test("blank ids are ignored instead of becoming phantom foreign models", () => {
  const conflict = conflictOf(["  nan-a  ", "", "   ", "other"]);
  assert.deepEqual(conflict.foreignModelIds, ["other"]);
  assert.equal(conflict.foreignModelCount, 1);
});

test("the conflict signature ignores host ordering", () => {
  assert.equal(
    vendorConflictSignature(conflictOf(["nan-a", "zeta", "alpha"])),
    vendorConflictSignature(conflictOf(["alpha", "nan-a", "zeta"])),
  );
});

test("the warning asks once per conflict set, then stays quiet on reactivation", async () => {
  const { state, values } = createState();
  const shown: string[] = [];
  const actions: string[] = [];
  const conflict = conflictOf(["nan-a", "foreign"]);

  const first = announceVendorConflictOnce({
    conflict,
    state,
    showWarningMessage: async (message, ...offered) => {
      shown.push(`${message}|${offered.join(",")}`);
      return SHOW_DIAGNOSTICS_ACTION;
    },
    onAction: (action) => actions.push(action),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(first, true);
  assert.equal(shown.length, 1);
  assert.match(shown[0]!, /nan-builders/);
  assert.match(shown[0]!, new RegExp(`${SHOW_DIAGNOSTICS_ACTION},${MANAGE_PROVIDER_ACTION}`));
  assert.match(shown[0]!, /other extension's API key/);
  assert.deepEqual(actions, [SHOW_DIAGNOSTICS_ACTION]);
  assert.deepEqual(values.get(VENDOR_CONFLICT_NOTIFIED_KEY), [vendorConflictSignature(conflict)]);

  const second = announceVendorConflictOnce({
    conflict,
    state,
    showWarningMessage: async () => {
      shown.push("unexpected");
      return undefined;
    },
    onAction: () => undefined,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(second, false);
  assert.equal(shown.length, 1);
});

test("a different conflicting model set warns again", async () => {
  const { state } = createState();
  const conflict = conflictOf(["nan-a", "foreign"]);
  const show = async (): Promise<string | undefined> => undefined;
  assert.equal(announceVendorConflictOnce({ conflict, state, showWarningMessage: show, onAction: () => undefined }), true);
  assert.equal(
    announceVendorConflictOnce({
      conflict: conflictOf(["nan-a", "foreign-2"]),
      state,
      showWarningMessage: show,
      onAction: () => undefined,
    }),
    true,
  );
});

test("the remembered conflict list stays bounded", () => {
  const { state, values } = createState();
  for (let index = 0; index < MAX_REMEMBERED_VENDOR_CONFLICTS + 5; index += 1) {
    announceVendorConflictOnce({
      conflict: conflictOf(["nan-a", `foreign-${index}`]),
      state,
      showWarningMessage: async () => undefined,
      onAction: () => undefined,
    });
  }
  const remembered = values.get(VENDOR_CONFLICT_NOTIFIED_KEY) as string[];
  assert.equal(remembered.length, MAX_REMEMBERED_VENDOR_CONFLICTS);
});

test("a corrupted remembered value is treated as empty", () => {
  const { state } = createState("not-an-array");
  assert.equal(
    announceVendorConflictOnce({
      conflict: conflictOf(["nan-a", "foreign"]),
      state,
      showWarningMessage: async () => undefined,
      onAction: () => undefined,
    }),
    true,
  );
});

test("the diagnostic payload and line carry ids and counts, never credentials", () => {
  const conflict = conflictOf(["nan-a", "foreign"]);
  const details = vendorConflictDiagnosticDetails(conflict);
  assert.deepEqual(Object.keys(details).sort(), [
    "duplicateModelIds",
    "foreignModelCount",
    "foreignModelIds",
    "observedModelCount",
    "ownModelCount",
    "vendor",
  ]);
  assert.equal(details.vendor, "nan-builders");
  assert.equal(details.foreignModelCount, 1);

  const rendered = JSON.stringify(details);
  assert.doesNotMatch(rendered, /api[-_]?key|authorization|bearer|secret/i);
  assert.equal(details.foreignModelIds, "foreign");
  assert.match(
    formatVendorConflictDiagnosticLine(conflict),
    /`provider\.vendorConflict`: vendor `nan-builders`; 1 model\(s\) observed from another provider; this extension is active/,
  );
});
