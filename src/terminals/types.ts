import type { SupportedTerminal } from "./detect.js";

export interface TerminalIntegration {
  terminal: SupportedTerminal;
  hasPrimaryKeybinding(): boolean;
  hasWorkspacesKeybinding(): boolean;
  hasChatKeybinding(): boolean;
  addPrimaryKeybinding(): string;
  addWorkspacesKeybinding(): string;
  addChatKeybinding(): string;
  removeKeybindings(): void;
}
