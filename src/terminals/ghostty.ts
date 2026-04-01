import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TerminalIntegration } from "./types.js";

const GHOSTTY_CONF = join(homedir(), ".config", "ghostty", "config");
const TOGGLE_MARKER = "# latch-keybinding";
const WORKSPACES_MARKER = "# latch-workspaces-keybinding";
const CHAT_MARKER = "# latch-chat-keybinding";
const TOGGLE_KEYBINDING = "keybind = cmd+e=text:\\x1be";
const WORKSPACES_KEYBINDING = "keybind = cmd+p=text:\\x1bp";
const CHAT_KEYBINDING = "keybind = cmd+s=text:\\x1bs";

function readConfig(): string {
  return existsSync(GHOSTTY_CONF) ? readFileSync(GHOSTTY_CONF, "utf-8") : "";
}

function writeConfig(content: string): void {
  mkdirSync(join(homedir(), ".config", "ghostty"), { recursive: true });
  writeFileSync(GHOSTTY_CONF, content);
}

function removeManagedEntry(content: string, marker: string, line: string): string {
  return content
    .replace(new RegExp(`\\n?${marker}\\n${line}\\n?`, "g"), "\n")
    .replace(new RegExp(`\\n?${line}\\n?`, "g"), "\n");
}

export const ghosttyIntegration: TerminalIntegration = {
  terminal: "ghostty",

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
    return "Ghostty config updated. Restart Ghostty to apply.";
  },

  addWorkspacesKeybinding(): string {
    const existing = readConfig();
    writeConfig(existing + `\n${WORKSPACES_MARKER}\n${WORKSPACES_KEYBINDING}\n`);
    return "Ghostty CMD+P keybinding added. Restart Ghostty to apply.";
  },

  addChatKeybinding(): string {
    const existing = readConfig();
    writeConfig(existing + `\n${CHAT_MARKER}\n${CHAT_KEYBINDING}\n`);
    return "Ghostty CMD+S keybinding added. Restart Ghostty to apply.";
  },

  removeKeybindings(): void {
    if (!existsSync(GHOSTTY_CONF)) return;
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
