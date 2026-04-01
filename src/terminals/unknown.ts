import { terminalDebugContext } from "./detect.js";
import type { TerminalIntegration } from "./types.js";

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
    return `Unknown terminal (${terminalDebugContext()}). Add CMD+E manually to send escape sequence \\x1be.`;
  },

  addWorkspacesKeybinding(): string {
    return `Unknown terminal (${terminalDebugContext()}). Add CMD+P manually to send escape sequence \\x1bp.`;
  },

  addChatKeybinding(): string {
    return `Unknown terminal (${terminalDebugContext()}). Add CMD+S manually to send escape sequence \\x1bs.`;
  },

  removeKeybindings(): void {},
};
