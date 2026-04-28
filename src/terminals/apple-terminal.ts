import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalIntegration } from "./types.js";
import {
  formatBindingList,
  formatManualBindings,
  getTerminalBinding,
  type TerminalBindingId,
} from "./shared.js";

const APPLE_TERMINAL_PLIST = join(homedir(), "Library", "Preferences", "com.apple.Terminal.plist");
const LATCH_MANAGED_KEY = "LatchManagedAppleTerminalKeyBindings";

const appleTerminalBindings = {
  primary: { key: "@0065", value: "\\033e" },
  workspaces: { key: "@0070", value: "\\033p" },
  chat: { key: "@0073", value: "\\033s" },
} as const satisfies Record<TerminalBindingId, { key: string; value: string }>;

type JsonObject = Record<string, unknown>;

type AppleTerminalBindingUpdateResult = {
  prefs: JsonObject;
  added: TerminalBindingId[];
  conflicts: TerminalBindingId[];
  profiles: string[];
};

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneRecord<T>(value: T): T {
  return structuredClone(value);
}

function ensureRecord(parent: JsonObject, key: string): JsonObject {
  const existing = parent[key];
  if (isRecord(existing)) {
    return existing;
  }
  const created: JsonObject = {};
  parent[key] = created;
  return created;
}

function hasKeys(record: JsonObject): boolean {
  return Object.keys(record).length > 0;
}

function readPrefs(): JsonObject | null {
  if (process.platform !== "darwin" || !existsSync(APPLE_TERMINAL_PLIST)) return null;
  try {
    const json = execFileSync("plutil", ["-convert", "json", APPLE_TERMINAL_PLIST, "-o", "-"], {
      encoding: "utf-8",
    });
    const parsed = JSON.parse(json);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return null;
  }
}

function writePrefs(prefs: JsonObject): void {
  const tmp = join(tmpdir(), `latch-apple-terminal-${process.pid}.json`);
  writeFileSync(tmp, JSON.stringify(prefs, null, 2));
  try {
    execFileSync("plutil", ["-convert", "binary1", tmp, "-o", APPLE_TERMINAL_PLIST]);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

export function getAppleTerminalTargetProfiles(prefs: JsonObject): string[] {
  const profiles = [prefs["Default Window Settings"], prefs["Startup Window Settings"]]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return [...new Set(profiles)];
}

function getProfileBindingMap(windowSettings: JsonObject, profile: string, create: boolean): JsonObject | null {
  const profileSettings = windowSettings[profile];
  if (!isRecord(profileSettings)) {
    if (!create) return null;
    const createdProfile: JsonObject = {};
    const createdBindingMap: JsonObject = {};
    createdProfile.keyMapBoundKeys = createdBindingMap;
    windowSettings[profile] = createdProfile;
    return createdBindingMap;
  }

  const bindingMap = profileSettings.keyMapBoundKeys;
  if (isRecord(bindingMap)) {
    return bindingMap;
  }

  if (!create) return null;
  const created: JsonObject = {};
  profileSettings.keyMapBoundKeys = created;
  return created;
}

function getManagedProfiles(prefs: JsonObject, create: boolean): JsonObject | null {
  const existing = prefs[LATCH_MANAGED_KEY];
  if (isRecord(existing)) {
    return existing;
  }
  if (!create) return null;
  const created: JsonObject = {};
  prefs[LATCH_MANAGED_KEY] = created;
  return created;
}

export function applyAppleTerminalBindings(
  prefs: JsonObject,
  bindingIds: TerminalBindingId[]
): AppleTerminalBindingUpdateResult {
  const nextPrefs = cloneRecord(prefs);
  const profiles = getAppleTerminalTargetProfiles(nextPrefs);
  if (profiles.length === 0) {
    return { prefs: nextPrefs, added: [], conflicts: [...bindingIds], profiles: [] };
  }

  const windowSettings = ensureRecord(nextPrefs, "Window Settings");
  const managedProfiles = getManagedProfiles(nextPrefs, true)!;
  const added = new Set<TerminalBindingId>();
  const conflicts = new Set<TerminalBindingId>();

  for (const profile of profiles) {
    const bindingMap = getProfileBindingMap(windowSettings, profile, true)!;
    const managedProfile = ensureRecord(managedProfiles, profile);

    for (const bindingId of bindingIds) {
      const spec = appleTerminalBindings[bindingId];
      const existing = bindingMap[spec.key];
      if (existing === spec.value) {
        continue;
      }
      if (existing !== undefined) {
        conflicts.add(bindingId);
        continue;
      }
      bindingMap[spec.key] = spec.value;
      managedProfile[spec.key] = true;
      added.add(bindingId);
    }

    if (!hasKeys(managedProfile)) {
      delete managedProfiles[profile];
    }
  }

  if (!hasKeys(managedProfiles)) {
    delete nextPrefs[LATCH_MANAGED_KEY];
  }

  return {
    prefs: nextPrefs,
    added: [...added],
    conflicts: [...conflicts],
    profiles,
  };
}

export function removeManagedAppleTerminalBindings(prefs: JsonObject): JsonObject {
  const nextPrefs = cloneRecord(prefs);
  const managedProfiles = getManagedProfiles(nextPrefs, false);
  const windowSettings = isRecord(nextPrefs["Window Settings"]) ? nextPrefs["Window Settings"] : null;

  if (!managedProfiles || !windowSettings) {
    return nextPrefs;
  }

  for (const [profile, managedValue] of Object.entries(managedProfiles)) {
    if (!isRecord(managedValue)) {
      delete managedProfiles[profile];
      continue;
    }

    const bindingMap = getProfileBindingMap(windowSettings, profile, false);
    if (bindingMap) {
      for (const bindingId of Object.keys(appleTerminalBindings) as TerminalBindingId[]) {
        const spec = appleTerminalBindings[bindingId];
        if (managedValue[spec.key] && bindingMap[spec.key] === spec.value) {
          delete bindingMap[spec.key];
        }
        delete managedValue[spec.key];
      }

      if (!hasKeys(bindingMap)) {
        const profileSettings = windowSettings[profile];
        if (isRecord(profileSettings)) {
          delete profileSettings.keyMapBoundKeys;
        }
      }
    }

    if (!hasKeys(managedValue)) {
      delete managedProfiles[profile];
    }
  }

  if (!hasKeys(managedProfiles)) {
    delete nextPrefs[LATCH_MANAGED_KEY];
  }

  return nextPrefs;
}

function manualInstructions(bindingIds: TerminalBindingId[]): string {
  return `Settings > Profiles > Keyboard: ${formatManualBindings(
    bindingIds,
    (binding) => `${binding.shortcut} -> Send string to shell -> ${binding.escapeSequence}`
  )} on the default and startup profiles. Quit and reopen Terminal.`;
}

function formatResult(result: AppleTerminalBindingUpdateResult): string {
  if (result.profiles.length === 0) {
    return `Apple Terminal detected, but automatic update failed. ${manualInstructions(result.conflicts)}`;
  }

  if (result.added.length === 0 && result.conflicts.length === 0) {
    return "Apple Terminal shortcuts already configured.";
  }

  if (result.conflicts.length === 0) {
    return result.added.length === 3
      ? "Apple Terminal shortcuts updated for the default and startup profiles. Quit and reopen Terminal to apply."
      : `Apple Terminal ${formatBindingList(result.added)} shortcut${result.added.length > 1 ? "s" : ""} added for the default and startup profiles. Quit and reopen Terminal to apply.`;
  }

  if (result.added.length === 0) {
    return `Apple Terminal left existing ${formatBindingList(result.conflicts)} shortcut${result.conflicts.length > 1 ? "s" : ""} unchanged. ${manualInstructions(result.conflicts)}`;
  }

  return `Apple Terminal added ${formatBindingList(result.added)} for the default and startup profiles. Left existing ${formatBindingList(result.conflicts)} shortcut${result.conflicts.length > 1 ? "s" : ""} unchanged. ${manualInstructions(result.conflicts)}`;
}

function updateBindings(bindingIds: TerminalBindingId[]): string {
  const prefs = readPrefs();
  if (!prefs) {
    return `Could not update Apple Terminal automatically. ${manualInstructions(bindingIds)}`;
  }

  try {
    const result = applyAppleTerminalBindings(prefs, bindingIds);
    if (result.profiles.length === 0) {
      return formatResult(result);
    }
    writePrefs(result.prefs);
    return formatResult(result);
  } catch {
    return `Could not update Apple Terminal automatically. ${manualInstructions(bindingIds)}`;
  }
}

function hasBinding(bindingId: TerminalBindingId): boolean {
  const prefs = readPrefs();
  if (!prefs) return false;
  const profiles = getAppleTerminalTargetProfiles(prefs);
  if (profiles.length === 0) return false;
  const windowSettings = isRecord(prefs["Window Settings"]) ? prefs["Window Settings"] : null;
  if (!windowSettings) return false;

  const spec = appleTerminalBindings[bindingId];
  return profiles.every((profile) => {
    const bindingMap = getProfileBindingMap(windowSettings, profile, false);
    return bindingMap?.[spec.key] === spec.value;
  });
}

export const appleTerminalIntegration: TerminalIntegration = {
  terminal: "apple_terminal",

  hasPrimaryKeybinding(): boolean {
    return hasBinding("primary");
  },

  hasWorkspacesKeybinding(): boolean {
    return hasBinding("workspaces");
  },

  hasChatKeybinding(): boolean {
    return hasBinding("chat");
  },

  addPrimaryKeybinding(): string {
    return updateBindings(["primary", "workspaces", "chat"]);
  },

  addWorkspacesKeybinding(): string {
    return updateBindings(["workspaces"]);
  },

  addChatKeybinding(): string {
    return updateBindings(["chat"]);
  },

  removeKeybindings(): void {
    const prefs = readPrefs();
    if (!prefs) return;
    try {
      writePrefs(removeManagedAppleTerminalBindings(prefs));
    } catch {}
  },
};
