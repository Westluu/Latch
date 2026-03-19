import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const HOOK_MARKER = "latch-hook";

function getHookCommand(): string {
  const hookScript = resolve(import.meta.dirname, "hook.js");
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

export function initHook(): void {
  const settings = readSettings();

  if (hasLatchHook(settings)) {
    console.log("Latch hook is already configured in Claude Code.");
    return;
  }

  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = [];

  settings.hooks.PostToolUse.push({
    matcher: "Write|Edit",
    hooks: [
      {
        type: "command",
        command: getHookCommand(),
        timeout: 30,
      },
    ],
  });

  writeSettings(settings);
  console.log("Latch hook added to Claude Code.");
  console.log("Files created or edited by Claude will now auto-open in the sidecar.");
}

export function removeHook(): void {
  const settings = readSettings();

  if (!hasLatchHook(settings)) {
    console.log("No Latch hook found in Claude Code settings.");
    return;
  }

  settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(
    (entry: any) =>
      entry._id !== HOOK_MARKER &&
      !entry.hooks?.some((h: any) => h.command?.includes("latch") && h.command?.includes("hook"))
  );

  if (settings.hooks.PostToolUse.length === 0) {
    delete settings.hooks.PostToolUse;
  }

  writeSettings(settings);
  console.log("Latch hook removed from Claude Code.");
}
