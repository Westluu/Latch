import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalIntegration } from "./types.js";
import {
  formatBindingList,
  formatManualBindings,
  getTerminalBinding,
  type TerminalBindingId,
} from "./shared.js";

const ITERM2_PLIST = join(homedir(), "Library", "Preferences", "com.googlecode.iterm2.plist");
const LATCH_MANAGED_KEY = "LatchManagedGlobalKeyMap";
const ITERM2_ESCAPE_SEQUENCE_ACTION = 11;

const iterm2Bindings = {
  primary: { key: "0x65-0x100000-0xe", text: "e" },
  workspaces: { key: "0x70-0x100000-0x23", text: "p" },
  chat: { key: "0x73-0x100000-0x1", text: "s" },
} as const satisfies Record<TerminalBindingId, { key: string; text: string }>;

type JsonObject = Record<string, unknown>;

type Iterm2BindingUpdateResult = {
  prefs: JsonObject;
  added: TerminalBindingId[];
  overwritten: TerminalBindingId[];
};

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneRecord<T>(value: T): T {
  return structuredClone(value);
}

function ensureRecord(parent: JsonObject, key: string): JsonObject {
  const existing = parent[key];
  if (isRecord(existing)) {
    return existing;
  }
  const created: JsonObject = {};
  parent[key] = created;
  return created;
}

function hasKeys(record: JsonObject): boolean {
  return Object.keys(record).length > 0;
}

export function makeIterm2Binding(text: string): JsonObject {
  return {
    Action: ITERM2_ESCAPE_SEQUENCE_ACTION,
    Label: "Latch",
    Text: text,
    Version: 1,
  };
}

export function isExpectedIterm2Binding(value: unknown, text: string): boolean {
  if (!isRecord(value)) return false;
  return value.Action === ITERM2_ESCAPE_SEQUENCE_ACTION && value.Text === text;
}

function readPrefs(): JsonObject | null {
  if (process.platform !== "darwin" || !existsSync(ITERM2_PLIST)) return null;
  try {
    const json = execFileSync("plutil", ["-convert", "json", ITERM2_PLIST, "-o", "-"], {
      encoding: "utf-8",
    });
    const parsed = JSON.parse(json);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return null;
  }
}

function writePrefs(prefs: JsonObject): void {
  const tmp = join(tmpdir(), `latch-iterm2-${process.pid}.json`);
  writeFileSync(tmp, JSON.stringify(prefs, null, 2));
  try {
    execFileSync("plutil", ["-convert", "binary1", tmp, "-o", ITERM2_PLIST]);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

function manualInstructions(bindingIds: TerminalBindingId[]): string {
  return `Preferences > Keys > Key Bindings: ${formatManualBindings(
    bindingIds,
    (binding) => `${binding.shortcut} -> Send Escape Sequence -> ${binding.letter}`
  )}. Quit and reopen iTerm2.`;
}

function formatResult(result: Iterm2BindingUpdateResult, label: string): string {
  if (result.added.length === 0 && result.overwritten.length === 0) {
    return `iTerm2 ${label} already configured.`;
  }

  if (result.overwritten.length === 0) {
    return result.added.length === 3
      ? "iTerm2 shortcuts updated. Quit and reopen iTerm2 to apply."
      : `iTerm2 ${formatBindingList(result.added)} shortcut${result.added.length > 1 ? "s" : ""} added. Quit and reopen iTerm2 to apply.`;
  }

  const overwriteMessage = `Overwrote existing ${formatBindingList(result.overwritten)} shortcut${result.overwritten.length > 1 ? "s" : ""}. Quit and reopen iTerm2 to apply.`;
  if (result.added.length === 0) {
    return `iTerm2 ${overwriteMessage}`;
  }

  return `iTerm2 added ${formatBindingList(result.added)}. ${overwriteMessage}`;
}

export function applyIterm2Bindings(
  prefs: JsonObject,
  bindingIds: TerminalBindingId[]
): Iterm2BindingUpdateResult {
  const nextPrefs = cloneRecord(prefs);
  const globalKeyMap = ensureRecord(nextPrefs, "GlobalKeyMap");
  const managedKeyMap = ensureRecord(nextPrefs, LATCH_MANAGED_KEY);
  const added = new Set<TerminalBindingId>();
  const overwritten = new Set<TerminalBindingId>();

  for (const bindingId of bindingIds) {
    const spec = iterm2Bindings[bindingId];
    const existing = globalKeyMap[spec.key];

    if (isExpectedIterm2Binding(existing, spec.text)) {
      continue;
    }

    if (existing !== undefined) {
      managedKeyMap[spec.key] = structuredClone(existing);
      globalKeyMap[spec.key] = makeIterm2Binding(spec.text);
      overwritten.add(bindingId);
      continue;
    }

    globalKeyMap[spec.key] = makeIterm2Binding(spec.text);
    managedKeyMap[spec.key] = true;
    added.add(bindingId);
  }

  if (!hasKeys(managedKeyMap)) {
    delete nextPrefs[LATCH_MANAGED_KEY];
  }

  return {
    prefs: nextPrefs,
    added: [...added],
    overwritten: [...overwritten],
  };
}

export function removeManagedIterm2Bindings(prefs: JsonObject): JsonObject {
  const nextPrefs = cloneRecord(prefs);
  const globalKeyMap = isRecord(nextPrefs.GlobalKeyMap) ? nextPrefs.GlobalKeyMap : null;
  const managedKeyMap = isRecord(nextPrefs[LATCH_MANAGED_KEY]) ? nextPrefs[LATCH_MANAGED_KEY] : null;

  if (!globalKeyMap) {
    return nextPrefs;
  }

  for (const bindingId of Object.keys(iterm2Bindings) as TerminalBindingId[]) {
    const spec = iterm2Bindings[bindingId];
    const managedEntry = managedKeyMap?.[spec.key];
    const isManaged = managedEntry !== undefined;
    const isLegacyExactLatchEntry = isExpectedIterm2Binding(globalKeyMap[spec.key], spec.text);
    if (isManaged && isLegacyExactLatchEntry) {
      if (managedEntry === true) {
        delete globalKeyMap[spec.key];
      } else {
        globalKeyMap[spec.key] = managedEntry;
      }
    } else if (!managedKeyMap && isLegacyExactLatchEntry) {
      delete globalKeyMap[spec.key];
    }
    if (managedKeyMap) {
      delete managedKeyMap[spec.key];
    }
  }

  if (managedKeyMap && !hasKeys(managedKeyMap)) {
    delete nextPrefs[LATCH_MANAGED_KEY];
  }

  return nextPrefs;
}

function updateBindings(bindingIds: TerminalBindingId[], label: string): string {
  const prefs = readPrefs();
  if (!prefs) {
    return `Could not update iTerm2 automatically. ${manualInstructions(bindingIds)}`;
  }

  try {
    const result = applyIterm2Bindings(prefs, bindingIds);
    writePrefs(result.prefs);
    return formatResult(result, label);
  } catch {
    return `Could not update iTerm2 automatically. ${manualInstructions(bindingIds)}`;
  }
}

function hasBinding(bindingId: TerminalBindingId): boolean {
  const prefs = readPrefs();
  if (!prefs) return false;
  const globalKeyMap = isRecord(prefs.GlobalKeyMap) ? prefs.GlobalKeyMap : null;
  if (!globalKeyMap) return false;
  const spec = iterm2Bindings[bindingId];
  return isExpectedIterm2Binding(globalKeyMap[spec.key], spec.text);
}

export const iterm2Integration: TerminalIntegration = {
  terminal: "iterm2",

  hasPrimaryKeybinding(): boolean {
    return hasBinding("primary");
  },

  hasWorkspacesKeybinding(): boolean {
    return hasBinding("workspaces");
  },

  hasChatKeybinding(): boolean {
    return hasBinding("chat");
  },

  addPrimaryKeybinding(): string {
    return updateBindings(["primary", "workspaces", "chat"], getTerminalBinding("primary").label);
  },

  addWorkspacesKeybinding(): string {
    return updateBindings(["workspaces"], getTerminalBinding("workspaces").label);
  },

  addChatKeybinding(): string {
    return updateBindings(["chat"], getTerminalBinding("chat").label);
  },

  removeKeybindings(): void {
    const prefs = readPrefs();
    if (!prefs) return;
    try {
      writePrefs(removeManagedIterm2Bindings(prefs));
    } catch {}
  },
};
