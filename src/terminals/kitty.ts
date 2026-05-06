import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TerminalIntegration } from "./types.js";
import {
  configHasLine,
  removeManagedConfigBindings,
  upsertManagedConfigBindings,
} from "./shared.js";

const KITTY_CONF = join(homedir(), ".config", "kitty", "kitty.conf");
const TOGGLE_MARKER = "# latch-keybinding";
const WORKSPACES_MARKER = "# latch-workspaces-keybinding";
const CHAT_MARKER = "# latch-chat-keybinding";
const TOGGLE_KEYBINDING = "map cmd+e send_text all \\x1be";
const WORKSPACES_KEYBINDING = "map cmd+p send_text all \\x1bp";
const CHAT_KEYBINDING = "map cmd+s send_text all \\x1bs";

const bindings = [
  { marker: TOGGLE_MARKER, line: TOGGLE_KEYBINDING },
  { marker: WORKSPACES_MARKER, line: WORKSPACES_KEYBINDING },
  { marker: CHAT_MARKER, line: CHAT_KEYBINDING },
];

function readConfig(): string {
  return existsSync(KITTY_CONF) ? readFileSync(KITTY_CONF, "utf-8") : "";
}

function writeConfig(content: string): void {
  mkdirSync(join(homedir(), ".config", "kitty"), { recursive: true });
  writeFileSync(KITTY_CONF, content);
}

export const kittyIntegration: TerminalIntegration = {
  terminal: "kitty",

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
    return "Kitty shortcuts updated. Restart Kitty to apply.";
  },

  addWorkspacesKeybinding(): string {
    writeConfig(upsertManagedConfigBindings(readConfig(), [bindings[1]]));
    return "Kitty CMD+P shortcut added. Restart Kitty to apply.";
  },

  addChatKeybinding(): string {
    writeConfig(upsertManagedConfigBindings(readConfig(), [bindings[2]]));
    return "Kitty CMD+S shortcut added. Restart Kitty to apply.";
  },

  removeKeybindings(): void {
    if (!existsSync(KITTY_CONF)) return;
    writeConfig(removeManagedConfigBindings(readConfig(), bindings));
  },
};
