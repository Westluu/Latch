import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TerminalIntegration } from "./types.js";

const APPLE_TERMINAL_PLIST = join(homedir(), "Library", "Preferences", "com.apple.Terminal.plist");
const TOGGLE_KEY = "@0065";
const WORKSPACES_KEY = "@0070";
const CHAT_KEY = "@0073";
const TOGGLE_VALUE = "\\033e";
const WORKSPACES_VALUE = "\\033p";
const CHAT_VALUE = "\\033s";

function runPlistBuddy(command: string): string {
  return execSync(`/usr/libexec/PlistBuddy -c '${command}' "${APPLE_TERMINAL_PLIST}" 2>/dev/null`, {
    encoding: "utf-8",
  }).trim();
}

function targetProfiles(): string[] {
  if (!existsSync(APPLE_TERMINAL_PLIST)) return [];
  const names: string[] = [];
  try {
    const defaultProfile = runPlistBuddy('Print :"Default Window Settings"');
    if (defaultProfile) names.push(defaultProfile);
  } catch {}
  try {
    const startupProfile = runPlistBuddy('Print :"Startup Window Settings"');
    if (startupProfile) names.push(startupProfile);
  } catch {}
  return Array.from(new Set(names));
}

function ensureKeybinding(profile: string, key: string, value: string): void {
  const keyPath = `:"Window Settings":"${profile}":keyMapBoundKeys:${key}`;
  try {
    runPlistBuddy(`Print ${keyPath}`);
    runPlistBuddy(`Set ${keyPath} ${value}`);
  } catch {
    try {
      runPlistBuddy(`Add :"Window Settings":"${profile}":keyMapBoundKeys dict`);
    } catch {}
    runPlistBuddy(`Add ${keyPath} string ${value}`);
  }
}

function removeKeybinding(profile: string, key: string): void {
  const keyPath = `:"Window Settings":"${profile}":keyMapBoundKeys:${key}`;
  try {
    runPlistBuddy(`Delete ${keyPath}`);
  } catch {}
}

function hasKeybinding(key: string): boolean {
  for (const profile of targetProfiles()) {
    try {
      runPlistBuddy(`Print :"Window Settings":"${profile}":keyMapBoundKeys:${key}`);
      return true;
    } catch {}
  }
  return false;
}

function addBindings(bindings: Array<{ key: string; value: string }>): boolean {
  const profiles = targetProfiles();
  if (profiles.length === 0) return false;
  try {
    for (const profile of profiles) {
      for (const binding of bindings) {
        ensureKeybinding(profile, binding.key, binding.value);
      }
    }
    return true;
  } catch {
    return false;
  }
}

export const appleTerminalIntegration: TerminalIntegration = {
  terminal: "apple_terminal",

  hasPrimaryKeybinding(): boolean {
    return hasKeybinding(TOGGLE_KEY);
  },

  hasWorkspacesKeybinding(): boolean {
    return hasKeybinding(WORKSPACES_KEY);
  },

  hasChatKeybinding(): boolean {
    return hasKeybinding(CHAT_KEY);
  },

  addPrimaryKeybinding(): string {
    const ok = addBindings([
      { key: TOGGLE_KEY, value: TOGGLE_VALUE },
      { key: WORKSPACES_KEY, value: WORKSPACES_VALUE },
      { key: CHAT_KEY, value: CHAT_VALUE },
    ]);
    return ok
      ? "Apple Terminal key bindings added for startup/default profile. Restart Terminal to apply."
      : "Apple Terminal detected, but automatic keybinding update failed. Add CMD+E manually in Settings -> Profiles -> Keyboard as 'Send string to shell' with value \\033e.";
  },

  addWorkspacesKeybinding(): string {
    const ok = addBindings([{ key: WORKSPACES_KEY, value: WORKSPACES_VALUE }]);
    return ok
      ? "Apple Terminal CMD+P keybinding added for startup/default profile. Restart Terminal to apply."
      : "Apple Terminal detected, but automatic keybinding update failed. Add CMD+P manually in Settings -> Profiles -> Keyboard as 'Send string to shell' with value \\033p.";
  },

  addChatKeybinding(): string {
    const ok = addBindings([{ key: CHAT_KEY, value: CHAT_VALUE }]);
    return ok
      ? "Apple Terminal CMD+S keybinding added for startup/default profile. Restart Terminal to apply."
      : "Apple Terminal detected, but automatic keybinding update failed. Add CMD+S manually in Settings -> Profiles -> Keyboard as 'Send string to shell' with value \\033s.";
  },

  removeKeybindings(): void {
    for (const profile of targetProfiles()) {
      removeKeybinding(profile, TOGGLE_KEY);
      removeKeybinding(profile, WORKSPACES_KEY);
      removeKeybinding(profile, CHAT_KEY);
    }
  },
};
