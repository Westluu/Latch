import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TerminalIntegration } from "./types.js";

const KITTY_CONF = join(homedir(), ".config", "kitty", "kitty.conf");
const TOGGLE_MARKER = "# latch-keybinding";
const WORKSPACES_MARKER = "# latch-workspaces-keybinding";
const CHAT_MARKER = "# latch-chat-keybinding";
const TOGGLE_KEYBINDING = "map cmd+e send_text all \\x1be";
const WORKSPACES_KEYBINDING = "map cmd+p send_text all \\x1bp";
const CHAT_KEYBINDING = "map cmd+s send_text all \\x1bs";

function readConfig(): string {
  return existsSync(KITTY_CONF) ? readFileSync(KITTY_CONF, "utf-8") : "";
}

function writeConfig(content: string): void {
  mkdirSync(join(homedir(), ".config", "kitty"), { recursive: true });
  writeFileSync(KITTY_CONF, content);
}

function removeManagedEntry(content: string, marker: string, line: string): string {
  return content
    .replace(new RegExp(`\\n?${marker}\\n${line}\\n?`, "g"), "\n")
    .replace(new RegExp(`\\n?${line}\\n?`, "g"), "\n");
}

export const kittyIntegration: TerminalIntegration = {
  terminal: "kitty",

  hasPrimaryKeybinding(): boolean {
    return readConfig().includes(TOGGLE_MARKER);
  },

  hasWorkspacesKeybinding(): boolean {
    return readConfig().includes(WORKSPACES_KEYBINDING);
  },

  hasChatKeybinding(): boolean {
    return readConfig().includes(CHAT_KEYBINDING);
  },

  addPrimaryKeybinding(): string {
    const existing = readConfig();
    writeConfig(
      existing +
        `\n${TOGGLE_MARKER}\n${TOGGLE_KEYBINDING}\n${WORKSPACES_MARKER}\n${WORKSPACES_KEYBINDING}\n${CHAT_MARKER}\n${CHAT_KEYBINDING}\n`
    );
    return "Kitty config updated. Restart Kitty to apply.";
  },

  addWorkspacesKeybinding(): string {
    const existing = readConfig();
    writeConfig(existing + `\n${WORKSPACES_MARKER}\n${WORKSPACES_KEYBINDING}\n`);
    return "Kitty CMD+P keybinding added. Restart Kitty to apply.";
  },

  addChatKeybinding(): string {
    const existing = readConfig();
    writeConfig(existing + `\n${CHAT_MARKER}\n${CHAT_KEYBINDING}\n`);
    return "Kitty CMD+S keybinding added. Restart Kitty to apply.";
  },

  removeKeybindings(): void {
    if (!existsSync(KITTY_CONF)) return;
    const content = readConfig();
    const cleaned = removeManagedEntry(
      removeManagedEntry(
        removeManagedEntry(content, CHAT_MARKER, CHAT_KEYBINDING),
        WORKSPACES_MARKER,
        WORKSPACES_KEYBINDING
      ),
      TOGGLE_MARKER,
      TOGGLE_KEYBINDING
    );
    writeConfig(cleaned);
  },
};
