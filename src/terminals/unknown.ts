import { terminalDebugContext } from "./detect.js";
import type { TerminalIntegration } from "./types.js";
import { formatManualBindings } from "./shared.js";

function manualSetupSummary(): string {
  return formatManualBindings(
    ["primary", "workspaces", "chat"],
    (binding) => `${binding.shortcut} -> ${binding.escapeHex}`
  );
}

export const unknownTerminalIntegration: TerminalIntegration = {
  terminal: "unknown",

  hasPrimaryKeybinding(): boolean {
    return false;
  },

  hasWorkspacesKeybinding(): boolean {
    return false;
  },

  hasChatKeybinding(): boolean {
    return false;
  },

  addPrimaryKeybinding(): string {
    return `Unsupported terminal (${terminalDebugContext()}). Configure ${manualSetupSummary()} manually.`;
  },

  addWorkspacesKeybinding(): string {
    return `Unsupported terminal (${terminalDebugContext()}). Add CMD+P to send \\x1bp manually.`;
  },

  addChatKeybinding(): string {
    return `Unsupported terminal (${terminalDebugContext()}). Add CMD+S to send \\x1bs manually.`;
  },

  removeKeybindings(): void {},
};
