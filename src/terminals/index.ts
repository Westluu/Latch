import { appleTerminalIntegration } from "./apple-terminal.js";
import { detectTerminal, terminalDebugContext } from "./detect.js";
import { ghosttyIntegration } from "./ghostty.js";
import { iterm2Integration } from "./iterm2.js";
import { kittyIntegration } from "./kitty.js";
import type { SupportedTerminal } from "./detect.js";
import type { TerminalIntegration } from "./types.js";
import { unknownTerminalIntegration } from "./unknown.js";

const integrations: Record<SupportedTerminal, TerminalIntegration> = {
  ghostty: ghosttyIntegration,
  iterm2: iterm2Integration,
  kitty: kittyIntegration,
  apple_terminal: appleTerminalIntegration,
  unknown: unknownTerminalIntegration,
};

const supportedIntegrations = [
  ghosttyIntegration,
  iterm2Integration,
  kittyIntegration,
  appleTerminalIntegration,
] as const;

function currentIntegration(): TerminalIntegration {
  return integrations[detectTerminal()];
}

export { detectTerminal, terminalDebugContext };
export type { SupportedTerminal, TerminalIntegration };

export function hasTerminalKeybinding(): boolean {
  return currentIntegration().hasPrimaryKeybinding();
}

export function hasTerminalWorkspacesKeybinding(): boolean {
  return currentIntegration().hasWorkspacesKeybinding();
}

export function hasTerminalChatKeybinding(): boolean {
  return currentIntegration().hasChatKeybinding();
}

export function hasAnyTerminalKeybinding(): boolean {
  return supportedIntegrations.some(
    (integration) =>
      integration.hasPrimaryKeybinding()
      || integration.hasWorkspacesKeybinding()
      || integration.hasChatKeybinding()
  );
}

export function addTerminalKeybinding(): string {
  return currentIntegration().addPrimaryKeybinding();
}

export function addTerminalWorkspacesKeybinding(): string {
  return currentIntegration().addWorkspacesKeybinding();
}

export function addTerminalChatKeybinding(): string {
  return currentIntegration().addChatKeybinding();
}

export function removeTerminalKeybinding(): void {
  for (const integration of supportedIntegrations) {
    integration.removeKeybindings();
  }
}
