import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalIntegration } from "./types.js";
import { getTerminalBinding, type TerminalBindingId } from "./shared.js";

const APPLE_TERMINAL_PLIST = join(homedir(), "Library", "Preferences", "com.apple.Terminal.plist");
const LATCH_MANAGED_KEY = "LatchManagedAppleTerminalKeyBindings";
const OPTION_AS_META_KEY = "useOptionAsMetaKey";

const appleTerminalBindings = {
  primary: { key: "@$0065", value: "\\033e", shortcut: "CMD+SHIFT+E" },
  workspaces: { key: "@$0070", value: "\\033p", shortcut: "CMD+SHIFT+P" },
  chat: { key: "@$0073", value: "\\033s", shortcut: "CMD+SHIFT+S" },
} as const satisfies Record<TerminalBindingId, { key: string; value: string; shortcut: string }>;

const legacyAppleTerminalBindings = [
  { key: "@0065", value: "\\033e" },
  { key: "@0070", value: "\\033p" },
  { key: "@0073", value: "\\033s" },
  { key: "^0065", value: "\\033e" },
  { key: "^0070", value: "\\033p" },
  { key: "^0073", value: "\\033s" },
  { key: "$0065", value: "\\033e" },
  { key: "$0070", value: "\\033p" },
  { key: "$0073", value: "\\033s" },
  { key: "F704", value: "\\033e" },
  { key: "F705", value: "\\033p" },
  { key: "F706", value: "\\033s" },
] as const;

type JsonObject = Record<string, unknown>;

type AppleTerminalBindingUpdateResult = {
  prefs: JsonObject;
  added: TerminalBindingId[];
  overwritten: TerminalBindingId[];
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

function deleteIfEmptyRecord(parent: JsonObject, key: string): void {
  const value = parent[key];
  if (isRecord(value) && !hasKeys(value)) {
    delete parent[key];
  }
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

function getProfileSettings(windowSettings: JsonObject, profile: string, create: boolean): JsonObject | null {
  const profileSettings = windowSettings[profile];
  if (isRecord(profileSettings)) {
    return profileSettings;
  }
  if (!create) return null;
  const created: JsonObject = {};
  windowSettings[profile] = created;
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

function restoreManagedOptionMeta(profileSettings: JsonObject, managedProfile: JsonObject): void {
  const managedOptionValue = managedProfile[OPTION_AS_META_KEY];
  if (managedOptionValue === undefined) return;
  if (profileSettings[OPTION_AS_META_KEY] === true || profileSettings[OPTION_AS_META_KEY] === 1) {
    if (managedOptionValue === "__ABSENT__") {
      delete profileSettings[OPTION_AS_META_KEY];
    } else {
      profileSettings[OPTION_AS_META_KEY] = managedOptionValue;
    }
  }
  delete managedProfile[OPTION_AS_META_KEY];
}

function restoreManagedBindings(bindingMap: JsonObject | null, managedProfile: JsonObject, bindings: readonly { key: string; value: string }[]): void {
  if (!bindingMap) return;
  for (const binding of bindings) {
    const managedEntry = managedProfile[binding.key];
    if (managedEntry !== undefined && bindingMap[binding.key] === binding.value) {
      if (managedEntry === true) {
        delete bindingMap[binding.key];
      } else {
        bindingMap[binding.key] = managedEntry;
      }
    }
    delete managedProfile[binding.key];
  }
}

export function applyAppleTerminalBindings(
  prefs: JsonObject,
  bindingIds: TerminalBindingId[]
): AppleTerminalBindingUpdateResult {
  const nextPrefs = cloneRecord(prefs);
  const profiles = getAppleTerminalTargetProfiles(nextPrefs);
  if (profiles.length === 0) {
    return { prefs: nextPrefs, added: [], overwritten: [], profiles: [] };
  }

  const windowSettings = ensureRecord(nextPrefs, "Window Settings");
  const managedProfiles = getManagedProfiles(nextPrefs, true)!;
  const added = new Set<TerminalBindingId>();
  const overwritten = new Set<TerminalBindingId>();

  for (const profile of profiles) {
    const profileSettings = getProfileSettings(windowSettings, profile, true)!;
    const managedProfile = ensureRecord(managedProfiles, profile);

    restoreManagedOptionMeta(profileSettings, managedProfile);
    const bindingMap = getProfileBindingMap(windowSettings, profile, true)!;
    restoreManagedBindings(bindingMap, managedProfile, legacyAppleTerminalBindings);

    for (const bindingId of bindingIds) {
      const spec = appleTerminalBindings[bindingId];
      const existing = bindingMap[spec.key];
      if (existing === spec.value) {
        continue;
      }
      if (existing !== undefined) {
        managedProfile[spec.key] = structuredClone(existing);
        bindingMap[spec.key] = spec.value;
        overwritten.add(bindingId);
        continue;
      }
      bindingMap[spec.key] = spec.value;
      managedProfile[spec.key] = true;
      added.add(bindingId);
    }

    deleteIfEmptyRecord(profileSettings, "keyMapBoundKeys");
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
    overwritten: [...overwritten],
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

  const allBindings = [
    ...Object.values(appleTerminalBindings),
    ...legacyAppleTerminalBindings,
  ];

  for (const [profile, managedValue] of Object.entries(managedProfiles)) {
    if (!isRecord(managedValue)) {
      delete managedProfiles[profile];
      continue;
    }

    const profileSettings = getProfileSettings(windowSettings, profile, false);
    if (profileSettings) {
      restoreManagedOptionMeta(profileSettings, managedValue);
      const bindingMap = getProfileBindingMap(windowSettings, profile, false);
      restoreManagedBindings(bindingMap, managedValue, allBindings);
      deleteIfEmptyRecord(profileSettings, "keyMapBoundKeys");
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

function manualInstructions(): string {
  return `Settings > Profiles > Keyboard: create ${(["primary", "workspaces", "chat"] as TerminalBindingId[]).map((bindingId) => {
    const binding = appleTerminalBindings[bindingId];
    const descriptor = getTerminalBinding(bindingId);
    return `${binding.shortcut} -> Send string to shell -> ${descriptor.escapeSequence}`;
  }).join("; ")} on the default and startup profiles. Quit and reopen Terminal.`;
}

function formatAppleBindingList(bindingIds: TerminalBindingId[]): string {
  return bindingIds.map((bindingId) => appleTerminalBindings[bindingId].shortcut).join(", ");
}

function formatResult(result: AppleTerminalBindingUpdateResult): string {
  if (result.profiles.length === 0) {
    return `Apple Terminal detected, but automatic update failed. ${manualInstructions()}`;
  }

  if (result.added.length === 0 && result.overwritten.length === 0) {
    return "Apple Terminal Command-Shift shortcuts already configured.";
  }

  if (result.overwritten.length === 0) {
    return result.added.length === 3
      ? "Apple Terminal Command-Shift shortcuts updated for the default and startup profiles. Quit and reopen Terminal to apply."
      : `Apple Terminal ${formatAppleBindingList(result.added)} shortcut${result.added.length > 1 ? "s" : ""} added for the default and startup profiles. Quit and reopen Terminal to apply.`;
  }

  const overwriteMessage = `Overwrote existing ${formatAppleBindingList(result.overwritten)} shortcut${result.overwritten.length > 1 ? "s" : ""} for the default and startup profiles. Quit and reopen Terminal to apply.`;
  if (result.added.length === 0) {
    return `Apple Terminal ${overwriteMessage}`;
  }

  return `Apple Terminal added ${formatAppleBindingList(result.added)} for the default and startup profiles. ${overwriteMessage}`;
}

function updateBindings(bindingIds: TerminalBindingId[]): string {
  const prefs = readPrefs();
  if (!prefs) {
    return `Could not update Apple Terminal automatically. ${manualInstructions()}`;
  }

  try {
    const result = applyAppleTerminalBindings(prefs, bindingIds);
    if (result.profiles.length === 0) {
      return formatResult(result);
    }
    writePrefs(result.prefs);
    return formatResult(result);
  } catch {
    return `Could not update Apple Terminal automatically. ${manualInstructions()}`;
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
