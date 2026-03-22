import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const HOOK_MARKER = "latch-hook";

function getHookCommand(): string {
  const hookScript = resolve(import.meta.dirname, "hook.js");
  return `node "${hookScript}"`;
}

function getStopHookCommand(): string {
  const hookScript = resolve(import.meta.dirname, "stop-hook.js");
  return `node "${hookScript}"`;
}

function getSessionEndHookCommand(): string {
  const hookScript = resolve(import.meta.dirname, "session-end-hook.js");
  return `node "${hookScript}"`;
}

function readSettings(): any {
  if (!existsSync(SETTINGS_PATH)) {
    return {};
  }
  return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
}

function writeSettings(settings: any): void {
  const dir = join(homedir(), ".claude");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

function hasLatchHook(settings: any): boolean {
  const postToolUse = settings.hooks?.PostToolUse;
  if (!Array.isArray(postToolUse)) return false;
  return postToolUse.some(
    (entry: any) =>
      entry.hooks?.some((h: any) => h.command?.includes("latch") && h.command?.includes("hook"))
  );
}

function hasLatchStopHook(settings: any): boolean {
  const stop = settings.hooks?.Stop;
  if (!Array.isArray(stop)) return false;
  return stop.some(
    (entry: any) => entry.hooks?.some((h: any) => h.command?.includes("stop-hook"))
  );
}

function hasLatchSessionEndHook(settings: any): boolean {
  const sessionEnd = settings.hooks?.SessionEnd;
  if (!Array.isArray(sessionEnd)) return false;
  return sessionEnd.some(
    (entry: any) => entry.hooks?.some((h: any) => h.command?.includes("session-end-hook"))
  );
}

export function initHook(): void {
  const settings = readSettings();

  if (hasLatchHook(settings)) {
    console.log("Latch hook is already configured in Claude Code.");
    return;
  }

  if (!settings.hooks) settings.hooks = {};

  if (!hasLatchHook(settings)) {
    if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = [];
    settings.hooks.PostToolUse.push({
      matcher: "Write|Edit",
      hooks: [{ type: "command", command: getHookCommand(), timeout: 30 }],
    });
  }

  if (!hasLatchStopHook(settings)) {
    if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];
    settings.hooks.Stop.push({
      hooks: [{ type: "command", command: getStopHookCommand(), timeout: 30 }],
    });
  }

  if (!hasLatchSessionEndHook(settings)) {
    if (!Array.isArray(settings.hooks.SessionEnd)) settings.hooks.SessionEnd = [];
    settings.hooks.SessionEnd.push({
      hooks: [{ type: "command", command: getSessionEndHookCommand(), timeout: 10 }],
    });
  }

  writeSettings(settings);
  console.log("Latch hooks added to Claude Code.");
}

export function removeHook(): void {
  const settings = readSettings();

  let removed = false;

  if (hasLatchHook(settings)) {
    settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(
      (entry: any) =>
        entry._id !== HOOK_MARKER &&
        !entry.hooks?.some((h: any) => h.command?.includes("latch") && h.command?.includes("hook"))
    );
    if (settings.hooks.PostToolUse.length === 0) delete settings.hooks.PostToolUse;
    removed = true;
  }

  if (hasLatchStopHook(settings)) {
    settings.hooks.Stop = settings.hooks.Stop.filter(
      (entry: any) => !entry.hooks?.some((h: any) => h.command?.includes("stop-hook"))
    );
    if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
    removed = true;
  }

  if (hasLatchSessionEndHook(settings)) {
    settings.hooks.SessionEnd = settings.hooks.SessionEnd.filter(
      (entry: any) => !entry.hooks?.some((h: any) => h.command?.includes("session-end-hook"))
    );
    if (settings.hooks.SessionEnd.length === 0) delete settings.hooks.SessionEnd;
    removed = true;
  }

  if (!removed) {
    console.log("No Latch hooks found in Claude Code settings.");
    return;
  }

  writeSettings(settings);
  console.log("Latch hooks removed from Claude Code.");
}
