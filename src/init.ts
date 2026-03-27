import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const HOOK_MARKER = "latch-hook";

const TMUX_CONF_PATH = join(homedir(), ".tmux.conf");
const TMUX_MARKER = "# latch-keybinding";
// CMD+E in iTerm2 sends ESC+e (M-e) when configured to send escape sequence "e"
const TMUX_KEYBINDING_LINE = `bind-key -n M-e run-shell "latch toggle"`;
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

// ── terminal detection ───────────────────────────────────────────────────────

type SupportedTerminal = "ghostty" | "iterm2" | "kitty" | "unknown";

function detectTerminal(): SupportedTerminal {
  if (process.env.TERM_PROGRAM === "ghostty") return "ghostty";
  if (process.env.TERM_PROGRAM === "iTerm.app" || process.env.ITERM_SESSION_ID) return "iterm2";
  if (process.env.KITTY_WINDOW_ID || process.env.TERM === "xterm-kitty") return "kitty";
  return "unknown";
}

// ── ghostty ──────────────────────────────────────────────────────────────────

const GHOSTTY_CONF = join(homedir(), ".config", "ghostty", "config");
const GHOSTTY_KEYBINDING = "keybind = cmd+e=text:\\x1be";
const GHOSTTY_CHAT_KEYBINDING = "keybind = cmd+s=text:\\x1bs";

function hasGhosttyKeybinding(): boolean {
  if (!existsSync(GHOSTTY_CONF)) return false;
  return readFileSync(GHOSTTY_CONF, "utf-8").includes(TMUX_MARKER);
}

function addGhosttyKeybinding(): void {
  mkdirSync(join(homedir(), ".config", "ghostty"), { recursive: true });
  const existing = existsSync(GHOSTTY_CONF) ? readFileSync(GHOSTTY_CONF, "utf-8") : "";
  writeFileSync(GHOSTTY_CONF, existing + `\n${TMUX_MARKER}\n${GHOSTTY_KEYBINDING}\n${GHOSTTY_CHAT_KEYBINDING}\n`);
}

function removeGhosttyKeybinding(): void {
  if (!existsSync(GHOSTTY_CONF)) return;
  const content = readFileSync(GHOSTTY_CONF, "utf-8");
  const cleaned = content
    .replace(new RegExp(`\\n?${TMUX_MARKER}\\n${GHOSTTY_KEYBINDING}\\n${GHOSTTY_CHAT_KEYBINDING}\\n?`, "g"), "\n")
    .replace(new RegExp(`\\n?${TMUX_MARKER}\\n${GHOSTTY_KEYBINDING}\\n?`, "g"), "\n");
  writeFileSync(GHOSTTY_CONF, cleaned);
}

// ── kitty ────────────────────────────────────────────────────────────────────

const KITTY_CONF = join(homedir(), ".config", "kitty", "kitty.conf");
const KITTY_KEYBINDING = "map cmd+e send_text all \\x1be";
const KITTY_CHAT_KEYBINDING = "map cmd+s send_text all \\x1bs";

function hasKittyKeybinding(): boolean {
  if (!existsSync(KITTY_CONF)) return false;
  return readFileSync(KITTY_CONF, "utf-8").includes(TMUX_MARKER);
}

function addKittyKeybinding(): void {
  mkdirSync(join(homedir(), ".config", "kitty"), { recursive: true });
  const existing = existsSync(KITTY_CONF) ? readFileSync(KITTY_CONF, "utf-8") : "";
  writeFileSync(KITTY_CONF, existing + `\n${TMUX_MARKER}\n${KITTY_KEYBINDING}\n${KITTY_CHAT_KEYBINDING}\n`);
}

function removeKittyKeybinding(): void {
  if (!existsSync(KITTY_CONF)) return;
  const content = readFileSync(KITTY_CONF, "utf-8");
  const cleaned = content
    .replace(new RegExp(`\\n?${TMUX_MARKER}\\n${KITTY_KEYBINDING}\\n${KITTY_CHAT_KEYBINDING}\\n?`, "g"), "\n")
    .replace(new RegExp(`\\n?${TMUX_MARKER}\\n${KITTY_KEYBINDING}\\n?`, "g"), "\n");
  writeFileSync(KITTY_CONF, cleaned);
}

// ── iTerm2 ───────────────────────────────────────────────────────────────────

const ITERM2_PLIST = join(homedir(), "Library", "Preferences", "com.googlecode.iterm2.plist");
// CMD+E: char=0x65, modifier=NSCommandKeyMask=0x100000, keycode=kVK_ANSI_E=0xe
const ITERM2_KEY = "0x65-0x100000-0xe";
// CMD+S: char=0x73, modifier=NSCommandKeyMask=0x100000, keycode=kVK_ANSI_S=0x1
const ITERM2_CHAT_KEY = "0x73-0x100000-0x1";

function readIterm2Prefs(): any | null {
  if (!existsSync(ITERM2_PLIST)) return null;
  try {
    const json = execSync(`plutil -convert json "${ITERM2_PLIST}" -o -`, { encoding: "utf-8" });
    return JSON.parse(json);
  } catch { return null; }
}

function writeIterm2Prefs(prefs: any): void {
  const tmp = join(tmpdir(), "latch-iterm2.json");
  writeFileSync(tmp, JSON.stringify(prefs));
  try {
    execSync(`plutil -convert binary1 "${tmp}" -o "${ITERM2_PLIST}"`);
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

function hasIterm2Keybinding(): boolean {
  const prefs = readIterm2Prefs();
  if (!prefs) return false;
  return !!prefs.GlobalKeyMap?.[ITERM2_KEY];
}

function addIterm2Keybinding(): boolean {
  const prefs = readIterm2Prefs();
  if (!prefs) return false;
  try {
    if (!prefs.GlobalKeyMap) prefs.GlobalKeyMap = {};
    prefs.GlobalKeyMap[ITERM2_KEY] = { Action: 11, Text: "e" };
    prefs.GlobalKeyMap[ITERM2_CHAT_KEY] = { Action: 11, Text: "s" };
    writeIterm2Prefs(prefs);
    return true;
  } catch { return false; }
}

function removeIterm2Keybinding(): void {
  const prefs = readIterm2Prefs();
  if (!prefs?.GlobalKeyMap) return;
  try {
    delete prefs.GlobalKeyMap[ITERM2_KEY];
    delete prefs.GlobalKeyMap[ITERM2_CHAT_KEY];
    writeIterm2Prefs(prefs);
  } catch {}
}

// ── unified terminal keybinding ──────────────────────────────────────────────

function addTerminalKeybinding(): string {
  const terminal = detectTerminal();
  switch (terminal) {
    case "ghostty":
      addGhosttyKeybinding();
      return "Ghostty config updated. Restart Ghostty to apply.";
    case "iterm2": {
      const ok = addIterm2Keybinding();
      return ok
        ? "iTerm2 key binding added. Quit and reopen iTerm2 to apply."
        : "Could not update iTerm2 automatically.\n  Preferences → Keys → Key Bindings → +\n  Shortcut: CMD+E | Action: Send Escape Sequence | Esc+: e";
    }
    case "kitty":
      addKittyKeybinding();
      return "Kitty config updated. Restart Kitty to apply.";
    default:
      return "Unknown terminal. Add CMD+E manually to send escape sequence \\x1be.";
  }
}

function hasTerminalKeybinding(): boolean {
  return hasGhosttyKeybinding() || hasIterm2Keybinding() || hasKittyKeybinding();
}

function hasTerminalChatKeybinding(): boolean {
  const terminal = detectTerminal();
  switch (terminal) {
    case "ghostty":
      return existsSync(GHOSTTY_CONF) && readFileSync(GHOSTTY_CONF, "utf-8").includes(GHOSTTY_CHAT_KEYBINDING);
    case "kitty":
      return existsSync(KITTY_CONF) && readFileSync(KITTY_CONF, "utf-8").includes(KITTY_CHAT_KEYBINDING);
    case "iterm2": {
      const prefs = readIterm2Prefs();
      return !!prefs?.GlobalKeyMap?.[ITERM2_CHAT_KEY];
    }
    default:
      return false;
  }
}

function addTerminalChatKeybinding(): string {
  const terminal = detectTerminal();
  switch (terminal) {
    case "ghostty": {
      const existing = existsSync(GHOSTTY_CONF) ? readFileSync(GHOSTTY_CONF, "utf-8") : "";
      writeFileSync(GHOSTTY_CONF, existing + `\n${GHOSTTY_CHAT_KEYBINDING}\n`);
      return "Ghostty CMD+S keybinding added. Restart Ghostty to apply.";
    }
    case "kitty": {
      const existing = existsSync(KITTY_CONF) ? readFileSync(KITTY_CONF, "utf-8") : "";
      writeFileSync(KITTY_CONF, existing + `\n${KITTY_CHAT_KEYBINDING}\n`);
      return "Kitty CMD+S keybinding added. Restart Kitty to apply.";
    }
    case "iterm2": {
      const prefs = readIterm2Prefs();
      if (prefs) {
        if (!prefs.GlobalKeyMap) prefs.GlobalKeyMap = {};
        prefs.GlobalKeyMap[ITERM2_CHAT_KEY] = { Action: 11, Text: "s" };
        writeIterm2Prefs(prefs);
        return "iTerm2 CMD+S keybinding added. Restart iTerm2 to apply.";
      }
      return "Could not update iTerm2 automatically.";
    }
    default:
      return "Unknown terminal. Add CMD+S manually to send escape sequence \\x1bs.";
  }
}

function removeTerminalKeybinding(): void {
  removeGhosttyKeybinding();
  removeIterm2Keybinding();
  removeKittyKeybinding();
}

function hasTmuxKeybinding(): boolean {
  if (!existsSync(TMUX_CONF_PATH)) return false;
  return readFileSync(TMUX_CONF_PATH, "utf-8").includes(TMUX_MARKER);
}

function hasTmuxChatKeybinding(): boolean {
  if (!existsSync(TMUX_CONF_PATH)) return false;
  return readFileSync(TMUX_CONF_PATH, "utf-8").includes(TMUX_CHAT_MARKER);
}

function addTmuxChatKeybinding(): void {
  const existing = existsSync(TMUX_CONF_PATH) ? readFileSync(TMUX_CONF_PATH, "utf-8") : "";
  writeFileSync(TMUX_CONF_PATH, existing + `\n${TMUX_CHAT_MARKER}\n${TMUX_CHAT_KEYBINDING_LINE}\n`);
  try { execSync(`tmux source-file "${TMUX_CONF_PATH}" 2>/dev/null`); } catch {}
}

function addTmuxKeybinding(): void {
  const existing = existsSync(TMUX_CONF_PATH) ? readFileSync(TMUX_CONF_PATH, "utf-8") : "";
  writeFileSync(TMUX_CONF_PATH, existing + `\n${TMUX_MARKER}\n${TMUX_KEYBINDING_LINE}\n${TMUX_CHAT_MARKER}\n${TMUX_CHAT_KEYBINDING_LINE}\n`);
  try { execSync(`tmux source-file "${TMUX_CONF_PATH}" 2>/dev/null`); } catch {}
}

function removeTmuxKeybinding(): void {
  if (!existsSync(TMUX_CONF_PATH)) return;
  const content = readFileSync(TMUX_CONF_PATH, "utf-8");
  const cleaned = content
    .replace(new RegExp(`\\n?${TMUX_CHAT_MARKER}\\n${TMUX_CHAT_KEYBINDING_LINE}\\n?`, "g"), "")
    .replace(new RegExp(`\\n?${TMUX_MARKER}\\n${TMUX_KEYBINDING_LINE}\\n?`, "g"), "\n");
  writeFileSync(TMUX_CONF_PATH, cleaned);
  try { execSync(`tmux source-file "${TMUX_CONF_PATH}" 2>/dev/null`); } catch {}
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
  } else if (!hasTmuxChatKeybinding()) {
    addTmuxChatKeybinding();
  }

  console.log("Latch hooks added to Claude Code.");

  if (!hasTerminalKeybinding()) {
    const msg = addTerminalKeybinding();
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
