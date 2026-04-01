import { execSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalIntegration } from "./types.js";

const ITERM2_PLIST = join(homedir(), "Library", "Preferences", "com.googlecode.iterm2.plist");
const TOGGLE_KEY = "0x65-0x100000-0xe";
const CHAT_KEY = "0x73-0x100000-0x1";
const WORKSPACES_KEY = "0x70-0x100000-0x23";

function readPrefs(): any | null {
  if (!existsSync(ITERM2_PLIST)) return null;
  try {
    const json = execSync(`plutil -convert json "${ITERM2_PLIST}" -o -`, { encoding: "utf-8" });
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function writePrefs(prefs: any): void {
  const tmp = join(tmpdir(), "latch-iterm2.json");
  writeFileSync(tmp, JSON.stringify(prefs));
  try {
    execSync(`plutil -convert binary1 "${tmp}" -o "${ITERM2_PLIST}"`);
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

export const iterm2Integration: TerminalIntegration = {
  terminal: "iterm2",

  hasPrimaryKeybinding(): boolean {
    const prefs = readPrefs();
    return !!prefs?.GlobalKeyMap?.[TOGGLE_KEY];
  },

  hasWorkspacesKeybinding(): boolean {
    const prefs = readPrefs();
    return !!prefs?.GlobalKeyMap?.[WORKSPACES_KEY];
  },

  hasChatKeybinding(): boolean {
    const prefs = readPrefs();
    return !!prefs?.GlobalKeyMap?.[CHAT_KEY];
  },

  addPrimaryKeybinding(): string {
    const prefs = readPrefs();
    if (!prefs) {
      return "Could not update iTerm2 automatically.\n  Preferences → Keys → Key Bindings → +\n  Shortcut: CMD+E | Action: Send Escape Sequence | Esc+: e";
    }

    try {
      if (!prefs.GlobalKeyMap) prefs.GlobalKeyMap = {};
      prefs.GlobalKeyMap[TOGGLE_KEY] = { Action: 11, Text: "e" };
      prefs.GlobalKeyMap[WORKSPACES_KEY] = { Action: 11, Text: "p" };
      prefs.GlobalKeyMap[CHAT_KEY] = { Action: 11, Text: "s" };
      writePrefs(prefs);
      return "iTerm2 key binding added. Quit and reopen iTerm2 to apply.";
    } catch {
      return "Could not update iTerm2 automatically.\n  Preferences → Keys → Key Bindings → +\n  Shortcut: CMD+E | Action: Send Escape Sequence | Esc+: e";
    }
  },

  addWorkspacesKeybinding(): string {
    const prefs = readPrefs();
    if (!prefs) return "Could not update iTerm2 automatically.";
    if (!prefs.GlobalKeyMap) prefs.GlobalKeyMap = {};
    prefs.GlobalKeyMap[WORKSPACES_KEY] = { Action: 11, Text: "p" };
    writePrefs(prefs);
    return "iTerm2 CMD+P keybinding added. Restart iTerm2 to apply.";
  },

  addChatKeybinding(): string {
    const prefs = readPrefs();
    if (!prefs) return "Could not update iTerm2 automatically.";
    if (!prefs.GlobalKeyMap) prefs.GlobalKeyMap = {};
    prefs.GlobalKeyMap[CHAT_KEY] = { Action: 11, Text: "s" };
    writePrefs(prefs);
    return "iTerm2 CMD+S keybinding added. Restart iTerm2 to apply.";
  },

  removeKeybindings(): void {
    const prefs = readPrefs();
    if (!prefs?.GlobalKeyMap) return;
    try {
      delete prefs.GlobalKeyMap[TOGGLE_KEY];
      delete prefs.GlobalKeyMap[WORKSPACES_KEY];
      delete prefs.GlobalKeyMap[CHAT_KEY];
      writePrefs(prefs);
    } catch {}
  },
};
