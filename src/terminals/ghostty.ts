import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TerminalIntegration } from "./types.js";
import {
  configHasLine,
  removeManagedConfigBindings,
  upsertManagedConfigBindings,
} from "./shared.js";

const GHOSTTY_CONF = join(homedir(), ".config", "ghostty", "config");
const TOGGLE_MARKER = "# latch-keybinding";
const WORKSPACES_MARKER = "# latch-workspaces-keybinding";
const CHAT_MARKER = "# latch-chat-keybinding";
const TOGGLE_KEYBINDING = "keybind = cmd+e=text:\\x1be";
const WORKSPACES_KEYBINDING = "keybind = cmd+p=text:\\x1bp";
const CHAT_KEYBINDING = "keybind = cmd+s=text:\\x1bs";

const bindings = [
  { marker: TOGGLE_MARKER, line: TOGGLE_KEYBINDING },
  { marker: WORKSPACES_MARKER, line: WORKSPACES_KEYBINDING },
  { marker: CHAT_MARKER, line: CHAT_KEYBINDING },
];

function readConfig(): string {
  return existsSync(GHOSTTY_CONF) ? readFileSync(GHOSTTY_CONF, "utf-8") : "";
}

function writeConfig(content: string): void {
  mkdirSync(join(homedir(), ".config", "ghostty"), { recursive: true });
  writeFileSync(GHOSTTY_CONF, content);
}

export const ghosttyIntegration: TerminalIntegration = {
  terminal: "ghostty",

  hasPrimaryKeybinding(): boolean {
    return configHasLine(readConfig(), TOGGLE_KEYBINDING);
  },

  hasWorkspacesKeybinding(): boolean {
    return configHasLine(readConfig(), WORKSPACES_KEYBINDING);
  },

  hasChatKeybinding(): boolean {
    return configHasLine(readConfig(), CHAT_KEYBINDING);
  },

  addPrimaryKeybinding(): string {
    writeConfig(upsertManagedConfigBindings(readConfig(), bindings));
    return "Ghostty shortcuts updated. Restart Ghostty to apply.";
  },

  addWorkspacesKeybinding(): string {
    writeConfig(upsertManagedConfigBindings(readConfig(), [bindings[1]]));
    return "Ghostty CMD+P shortcut added. Restart Ghostty to apply.";
  },

  addChatKeybinding(): string {
    writeConfig(upsertManagedConfigBindings(readConfig(), [bindings[2]]));
    return "Ghostty CMD+S shortcut added. Restart Ghostty to apply.";
  },

  removeKeybindings(): void {
    if (!existsSync(GHOSTTY_CONF)) return;
    writeConfig(removeManagedConfigBindings(readConfig(), bindings));
  },
};
