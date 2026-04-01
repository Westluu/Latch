import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { getPythonUiDependencyError } from "./tmux.js";
import {
  addTerminalChatKeybinding,
  addTerminalKeybinding,
  addTerminalWorkspacesKeybinding,
  hasTerminalChatKeybinding,
  hasTerminalKeybinding,
  hasTerminalWorkspacesKeybinding,
  removeTerminalKeybinding,
} from "./terminals/index.js";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const HOOK_MARKER = "latch-hook";

const TMUX_CONF_PATH = join(homedir(), ".tmux.conf");
const TMUX_MARKER = "# latch-keybinding";
const TMUX_WORKSPACES_MARKER = "# latch-workspaces-keybinding";
// CMD+E in iTerm2 sends ESC+e (M-e) when configured to send escape sequence "e"
const TMUX_KEYBINDING_LINE = `bind-key -n M-e run-shell "latch toggle"`;
const TMUX_WORKSPACES_KEYBINDING_LINE = `bind-key -n M-p run-shell "latch workspaces"`;
const TMUX_CHAT_KEYBINDING_LINE = `bind-key -n M-s run-shell "latch chat"`;
const TMUX_CHAT_MARKER = "# latch-chat-keybinding";

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

function getSessionStartHookCommand(): string {
  const hookScript = resolve(import.meta.dirname, "session-start-hook.js");
  return `node "${hookScript}"`;
}

function getPlanHookCommand(): string {
  const hookScript = resolve(import.meta.dirname, "plan-hook.js");
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

function hasLatchSessionStartHook(settings: any): boolean {
  const sessionStart = settings.hooks?.SessionStart;
  if (!Array.isArray(sessionStart)) return false;
  return sessionStart.some(
    (entry: any) => entry.hooks?.some((h: any) => h.command?.includes("session-start-hook"))
  );
}

function hasLatchPlanHook(settings: any): boolean {
  const postToolUse = settings.hooks?.PostToolUse;
  if (!Array.isArray(postToolUse)) return false;
  return postToolUse.some(
    (entry: any) => entry.hooks?.some((h: any) => h.command?.includes("plan-hook"))
  );
}

function commandExists(command: string): boolean {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" });
  return result.status === 0;
}

function hasTmuxInstalled(): boolean {
  const result = spawnSync("tmux", ["-V"], { stdio: "ignore" });
  return result.status === 0;
}

function installTmuxIfMissing(autoInstallTmux: boolean): void {
  if (hasTmuxInstalled()) return;

  if (!autoInstallTmux) {
    console.log("tmux is not installed. Install tmux, then rerun 'latch init'.");
    return;
  }

  if (process.platform === "darwin" && commandExists("brew")) {
    console.log("tmux not found. Installing with Homebrew...");
    const install = spawnSync("brew", ["install", "tmux"], { stdio: "inherit" });
    if (install.status === 0 && hasTmuxInstalled()) {
      console.log("tmux installed successfully.");
      return;
    }
    console.log("Failed to auto-install tmux with Homebrew. Install it manually, then rerun 'latch init'.");
    return;
  }

  console.log("tmux is not installed and no supported auto-installer was found. Install tmux manually, then rerun 'latch init'.");
}

function pythonRequirementsPath(): string {
  return resolve(import.meta.dirname, "..", "python", "requirements.txt");
}

function installPythonUiDependenciesIfMissing(autoInstallPythonDeps: boolean): void {
  const pythonDependencyError = getPythonUiDependencyError();
  if (!pythonDependencyError) return;

  const installCmd = `python3 -m pip install -r "${pythonRequirementsPath()}"`;

  if (!autoInstallPythonDeps) {
    console.log(pythonDependencyError);
    return;
  }

  console.log("Installing Latch Python dependencies...");
  const install = spawnSync("python3", ["-m", "pip", "install", "-r", pythonRequirementsPath()], {
    stdio: "inherit",
  });

  if (install.status === 0 && !getPythonUiDependencyError()) {
    console.log("Latch Python dependencies installed successfully.");
    return;
  }

  console.log(`Failed to install Latch Python dependencies automatically. Run \`${installCmd}\` and try again.`);
}

function hasTmuxKeybinding(): boolean {
  if (!existsSync(TMUX_CONF_PATH)) return false;
  return readFileSync(TMUX_CONF_PATH, "utf-8").includes(TMUX_MARKER);
}

function hasTmuxChatKeybinding(): boolean {
  if (!existsSync(TMUX_CONF_PATH)) return false;
  return readFileSync(TMUX_CONF_PATH, "utf-8").includes(TMUX_CHAT_MARKER);
}

function hasTmuxWorkspacesKeybinding(): boolean {
  if (!existsSync(TMUX_CONF_PATH)) return false;
  return readFileSync(TMUX_CONF_PATH, "utf-8").includes(TMUX_WORKSPACES_MARKER);
}

function addTmuxChatKeybinding(): void {
  const existing = existsSync(TMUX_CONF_PATH) ? readFileSync(TMUX_CONF_PATH, "utf-8") : "";
  writeFileSync(TMUX_CONF_PATH, existing + `\n${TMUX_CHAT_MARKER}\n${TMUX_CHAT_KEYBINDING_LINE}\n`);
  try { execSync(`tmux source-file "${TMUX_CONF_PATH}" 2>/dev/null`); } catch {}
}

function addTmuxWorkspacesKeybinding(): void {
  const existing = existsSync(TMUX_CONF_PATH) ? readFileSync(TMUX_CONF_PATH, "utf-8") : "";
  writeFileSync(TMUX_CONF_PATH, existing + `\n${TMUX_WORKSPACES_MARKER}\n${TMUX_WORKSPACES_KEYBINDING_LINE}\n`);
  try { execSync(`tmux source-file "${TMUX_CONF_PATH}" 2>/dev/null`); } catch {}
}

function addTmuxKeybinding(): void {
  const existing = existsSync(TMUX_CONF_PATH) ? readFileSync(TMUX_CONF_PATH, "utf-8") : "";
  writeFileSync(
    TMUX_CONF_PATH,
    existing + `\n${TMUX_MARKER}\n${TMUX_KEYBINDING_LINE}\n${TMUX_WORKSPACES_MARKER}\n${TMUX_WORKSPACES_KEYBINDING_LINE}\n${TMUX_CHAT_MARKER}\n${TMUX_CHAT_KEYBINDING_LINE}\n`
  );
  try { execSync(`tmux source-file "${TMUX_CONF_PATH}" 2>/dev/null`); } catch {}
}

function removeTmuxKeybinding(): void {
  if (!existsSync(TMUX_CONF_PATH)) return;
  const content = readFileSync(TMUX_CONF_PATH, "utf-8");
  const cleaned = content
    .replace(new RegExp(`\\n?${TMUX_CHAT_MARKER}\\n${TMUX_CHAT_KEYBINDING_LINE}\\n?`, "g"), "")
    .replace(new RegExp(`\\n?${TMUX_WORKSPACES_MARKER}\\n${TMUX_WORKSPACES_KEYBINDING_LINE}\\n?`, "g"), "")
    .replace(new RegExp(`\\n?${TMUX_MARKER}\\n${TMUX_KEYBINDING_LINE}\\n?`, "g"), "\n");
  writeFileSync(TMUX_CONF_PATH, cleaned);
  try { execSync(`tmux source-file "${TMUX_CONF_PATH}" 2>/dev/null`); } catch {}
}

export function initHook(options: { autoInstallTmux?: boolean; autoInstallPythonDeps?: boolean } = {}): void {
  const autoInstallTmux = options.autoInstallTmux ?? true;
  const autoInstallPythonDeps = options.autoInstallPythonDeps ?? true;
  installTmuxIfMissing(autoInstallTmux);
  installPythonUiDependenciesIfMissing(autoInstallPythonDeps);

  const settings = readSettings();

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

  if (!hasLatchSessionStartHook(settings)) {
    if (!Array.isArray(settings.hooks.SessionStart)) settings.hooks.SessionStart = [];
    settings.hooks.SessionStart.push({
      hooks: [{ type: "command", command: getSessionStartHookCommand(), timeout: 10 }],
    });
  }

  if (!hasLatchPlanHook(settings)) {
    if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = [];
    settings.hooks.PostToolUse.push({
      matcher: "ExitPlanMode",
      hooks: [{ type: "command", command: getPlanHookCommand(), timeout: 15 }],
    });
  }

  writeSettings(settings);

  if (!hasTmuxKeybinding()) {
    addTmuxKeybinding();
  } else if (!hasTmuxWorkspacesKeybinding()) {
    addTmuxWorkspacesKeybinding();
  } else if (!hasTmuxChatKeybinding()) {
    addTmuxChatKeybinding();
  }

  console.log("Latch hooks added to Claude Code.");

  if (!hasTerminalKeybinding()) {
    const msg = addTerminalKeybinding();
    console.log(msg);
  } else if (!hasTerminalWorkspacesKeybinding()) {
    const msg = addTerminalWorkspacesKeybinding();
    console.log(msg);
  } else if (!hasTerminalChatKeybinding()) {
    const msg = addTerminalChatKeybinding();
    console.log(msg);
  }
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

  if (hasLatchSessionStartHook(settings)) {
    settings.hooks.SessionStart = settings.hooks.SessionStart.filter(
      (entry: any) => !entry.hooks?.some((h: any) => h.command?.includes("session-start-hook"))
    );
    if (settings.hooks.SessionStart.length === 0) delete settings.hooks.SessionStart;
    removed = true;
  }

  if (hasLatchPlanHook(settings)) {
    settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(
      (entry: any) => !entry.hooks?.some((h: any) => h.command?.includes("plan-hook"))
    );
    if (settings.hooks.PostToolUse.length === 0) delete settings.hooks.PostToolUse;
    removed = true;
  }

  if (hasTmuxKeybinding()) {
    removeTmuxKeybinding();
    removed = true;
  }

  if (hasTerminalKeybinding()) {
    removeTerminalKeybinding();
    removed = true;
  }

  if (!removed) {
    console.log("No Latch hooks found in Claude Code settings.");
    return;
  }

  writeSettings(settings);
  console.log("Latch hooks removed from Claude Code.");
}
