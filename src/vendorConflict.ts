import { PROVIDER_VENDOR } from "./constants";

/**
 * Runtime detection of another extension registering the same immutable
 * model vendor (`nan-builders`, see docs/DECISIONS.md). The identity that
 * matters is the vendor id plus the set of model ids this extension publishes:
 * no publisher, display name, or icon is inspected.
 *
 * Kept free of the `vscode` module so detection, the once-per-conflict memory,
 * and the report line are unit-testable. Nothing here reads, stores, or formats
 * a key: only model ids and counts leave this module.
 */

/** Actions offered by the non-modal warning. */
export const SHOW_DIAGNOSTICS_ACTION = "Show Diagnostics";
export const MANAGE_PROVIDER_ACTION = "Manage Provider";

/** Global-state key listing the conflict signatures already warned about. */
export const VENDOR_CONFLICT_NOTIFIED_KEY = "nanBuilders.vendorConflictNotified";

/** Bound on remembered signatures so global state cannot grow unbounded. */
export const MAX_REMEMBERED_VENDOR_CONFLICTS = 20;

export interface VendorConflict {
  readonly vendor: string;
  /** Models the host listed for the vendor. */
  readonly observedModelCount: number;
  /** Models this extension currently publishes. */
  readonly ownModelCount: number;
  /**
   * Observed entries that cannot belong to this extension: ids it never
   * published, plus repeated occurrences of an id it publishes exactly once.
   */
  readonly foreignModelCount: number;
  /** Distinct foreign ids, sorted; safe to print (ids only). */
  readonly foreignModelIds: readonly string[];
  /** Ids this extension publishes once that the host listed more than once. */
  readonly duplicateModelIds: readonly string[];
}

/** Structural subset of `vscode.Memento` used for the once-per-conflict memory. */
export interface VendorConflictMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface VendorConflictAnnouncement {
  readonly conflict: VendorConflict;
  readonly state: VendorConflictMemento;
  /** Non-modal warning with the two fixed actions; resolves to the choice. */
  readonly showWarningMessage: (message: string, ...actions: string[]) => Thenable<string | undefined>;
  readonly onAction: (action: string) => void;
}

/**
 * Compares the models the host lists for `vendor` against the ids this
 * extension publishes. Returns `undefined` when nothing needs reporting:
 * no published models (no key, refresh in progress), no models observed, or a
 * partial host answer that does not include at least one of our ids. That last
 * guard keeps a partial `selectChatModels` result from blaming another
 * provider for models this extension simply has not published yet.
 *
 * Our provider publishes each id at most once, so a repeated id in the host
 * list is necessarily another provider's registration.
 */
export function detectVendorConflict(
  observedIds: readonly string[],
  ownModelIds: readonly string[],
  vendor: string = PROVIDER_VENDOR,
): VendorConflict | undefined {
  const own = new Set(ownModelIds.map((id) => id.trim()).filter((id) => id.length > 0));
  if (own.size === 0) {
    return undefined;
  }

  const observed = observedIds.map((id) => id.trim()).filter((id) => id.length > 0);
  const seenOwn = new Set<string>();
  const foreign: string[] = [];
  let ownVisible = false;
  for (const id of observed) {
    if (!own.has(id)) {
      foreign.push(id);
      continue;
    }
    ownVisible = true;
    if (seenOwn.has(id)) {
      foreign.push(id);
    } else {
      seenOwn.add(id);
    }
  }

  if (!ownVisible || foreign.length === 0) {
    return undefined;
  }

  const foreignIds = [...new Set(foreign)].sort();
  const duplicateIds = [...new Set(foreign.filter((id) => own.has(id)))].sort();
  return {
    vendor,
    observedModelCount: observed.length,
    ownModelCount: own.size,
    foreignModelCount: foreign.length,
    foreignModelIds: foreignIds,
    duplicateModelIds: duplicateIds,
  };
}

/** Stable identity of "this set of conflicting providers": isolated model ids. */
export function vendorConflictSignature(conflict: VendorConflict): string {
  return [...conflict.foreignModelIds].sort().join("\n");
}

/** Non-modal warning text. Names the vendor and the risk, never a key or id. */
export function formatVendorConflictMessage(conflict: VendorConflict): string {
  const models = conflict.foreignModelCount === 1 ? "model" : "models";
  return (
    `NaN Builders: another extension also registers the "${conflict.vendor}" vendor, so VS Code lists ` +
    `${conflict.foreignModelCount} ${models} that this extension did not publish. ` +
    `A model selection saved as "${conflict.vendor}/<model>" can now send a request with the other extension's API key. ` +
    `Choose "${SHOW_DIAGNOSTICS_ACTION}" for details or "${MANAGE_PROVIDER_ACTION}" to review this extension's setup.`
  );
}

/** `provider.vendorConflict` report line: vendor, foreign count, and our state. */
export function formatVendorConflictDiagnosticLine(conflict: VendorConflict): string {
  const duplicates =
    conflict.duplicateModelIds.length > 0
      ? ` Duplicate ids: ${conflict.duplicateModelIds.map((id) => `\`${id}\``).join(", ")}.`
      : "";
  return (
    `- \`provider.vendorConflict\`: vendor \`${conflict.vendor}\`; ` +
    `${conflict.foreignModelCount} model(s) observed from another provider; ` +
    `this extension is active (${conflict.ownModelCount} model(s) published). ` +
    `A saved model selection may use the other extension's API key.${duplicates}`
  );
}

/** Opt-in log payload: counts and model ids only, never keys or endpoints. */
export function vendorConflictDiagnosticDetails(
  conflict: VendorConflict,
): Record<string, string | number | boolean> {
  return {
    vendor: conflict.vendor,
    observedModelCount: conflict.observedModelCount,
    ownModelCount: conflict.ownModelCount,
    foreignModelCount: conflict.foreignModelCount,
    foreignModelIds: conflict.foreignModelIds.join(","),
    duplicateModelIds: conflict.duplicateModelIds.join(","),
  };
}

/**
 * Shows the warning once per conflict set. The signature is recorded before
 * the notification is requested, mirroring the failover reminder, so a reload
 * or reactivation can never repeat the same warning. A different foreign model
 * set (another provider update) is a new conflict and warns again.
 */
export function announceVendorConflictOnce(input: VendorConflictAnnouncement): boolean {
  const signature = vendorConflictSignature(input.conflict);
  const acknowledged = readAcknowledgedSignatures(input.state);
  if (acknowledged.includes(signature)) {
    return false;
  }

  void input.state.update(VENDOR_CONFLICT_NOTIFIED_KEY, [
    ...acknowledged.slice(-(MAX_REMEMBERED_VENDOR_CONFLICTS - 1)),
    signature,
  ]);

  const message = formatVendorConflictMessage(input.conflict);
  void input.showWarningMessage(message, SHOW_DIAGNOSTICS_ACTION, MANAGE_PROVIDER_ACTION).then(
    (choice) => {
      if (choice) {
        input.onAction(choice);
      }
    },
    () => undefined,
  );
  return true;
}

function readAcknowledgedSignatures(state: VendorConflictMemento): string[] {
  const stored = state.get<unknown>(VENDOR_CONFLICT_NOTIFIED_KEY, []);
  return Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === "string") : [];
}
