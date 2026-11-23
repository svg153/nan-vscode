/**
 * Pure QuickPick model for "NaN Builders: Switch Active Profile".
 *
 * Deliberately free of `vscode` imports so the rows and the resulting setting
 * value can be unit tested without a VS Code host. Only profile ids are handled
 * here; each key lives in SecretStorage and never reaches this module.
 */

import { normalizeProfileIds, resolveActiveProfile } from "./profiles";

/**
 * One row of the profile switcher. `profileId` is the exact value written to
 * `nanBuilders.activeProfile`.
 */
export interface ProfilePickItem {
  readonly profileId: string;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
}

/**
 * Configured profiles in settings order, with the profile that actually serves
 * unassigned models marked. The marking resolves through `resolveActiveProfile`,
 * so an empty or stale `nanBuilders.activeProfile` still marks the first
 * profile the routing code would use.
 */
export function buildProfilePickItems(
  profiles: readonly string[],
  activeProfile: string | undefined,
): ProfilePickItem[] {
  const configured = normalizeProfileIds(profiles);
  const active = resolveActiveProfile({ profiles: configured, activeProfile });
  return configured.map((profileId) => {
    const isActive = profileId === active;
    return {
      profileId,
      label: profileId,
      description: isActive ? "$(checkmark) active profile" : undefined,
      detail: isActive ? "Models without a profile::model assignment use this profile." : undefined,
    };
  });
}

/** Setting value for a picked row, or `undefined` when the picker was dismissed. */
export function profileFromPick(item: ProfilePickItem | undefined): string | undefined {
  return item?.profileId;
}

/** Active profile id, when any profile is configured; `undefined` means the legacy shared key. */
export function activeProfileName(
  profiles: readonly string[],
  activeProfile: string | undefined,
): string | undefined {
  return resolveActiveProfile({ profiles: normalizeProfileIds(profiles), activeProfile });
}

/**
 * Profile name for the status bar text, only when more than one profile is
 * configured. With a single profile the extra label adds noise without telling
 * the user anything actionable, so it stays in the tooltip only.
 */
export function statusBarProfileLabel(
  profiles: readonly string[],
  activeProfile: string | undefined,
): string | undefined {
  const configured = normalizeProfileIds(profiles);
  return configured.length > 1 ? resolveActiveProfile({ profiles: configured, activeProfile }) : undefined;
}
