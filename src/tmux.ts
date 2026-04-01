import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { detectTerminal } from "./terminals/index.js";

function paneStatePath(hashKey: string, suffix: string): string {
  const hash = createHash("sha256").update(hashKey).digest("hex").slice(0, 12);
  const dir = join(tmpdir(), "latch");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}-${suffix}.txt`);
}

function readPaneState(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8").trim() || null;
}

function writePaneState(path: string, value: string): void {
  writeFileSync(path, value);
}

function removePaneState(path: string): void {
  try { unlinkSync(path); } catch {}
}

function sidecarPanePath(cwd: string, sessionId: string = ""): string {
  return paneStatePath(cwd + sessionId, "sidecar-pane");
}

function workspacesPanePath(cwd: string): string {
  return paneStatePath(`${cwd}:workspaces`, "workspaces-pane");
}

function projectTargetPanePath(cwd: string): string {
  return paneStatePath(`${cwd}:project-target`, "project-target-pane");
}

export function saveSidecarPaneId(cwd: string, sessionId: string, paneId: string): void {
  writePaneState(sidecarPanePath(cwd, sessionId), paneId);
}

export function getSidecarPaneId(cwd: string, sessionId: string = ""): string | null {
  return readPaneState(sidecarPanePath(cwd, sessionId));
}

export function saveWorkspacesPaneId(cwd: string, paneId: string): void {
  writePaneState(workspacesPanePath(cwd), paneId);
}

export function getWorkspacesPaneId(cwd: string): string | null {
  return readPaneState(workspacesPanePath(cwd));
}

export function saveProjectTargetPaneId(cwd: string, paneId: string): void {
  writePaneState(projectTargetPanePath(cwd), paneId);
}

export function getProjectTargetPaneId(cwd: string): string | null {
  return readPaneState(projectTargetPanePath(cwd));
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export function isInsideTmux(): boolean {
  return !!process.env.TMUX;
}

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8" }).trim();
}

/** Returns the tmux session name the given pane belongs to, or "" on failure. */
export function getPaneSession(paneId: string): string {
  try {
    return run(`tmux display-message -t ${paneId} -p '#S'`);
  } catch {
    return "";
  }
}

/** Returns the tmux session name of the current process context, or "" on failure. */
export function getCurrentTmuxSession(): string {
  try {
    return run("tmux display-message -p '#S'");
  } catch {
    return "";
  }
}

/** Returns the pane id of the current process context, or "" on failure. */
export function getCurrentPaneId(): string {
  try {
    return run("tmux display-message -p '#{pane_id}'");
  } catch {
    return "";
  }
}

/** Returns true only if the pane exists AND belongs to the current tmux session. */
export function isPaneInCurrentSession(paneId: string): boolean {
  const current = getCurrentTmuxSession();
  if (!current) return false;
  return getPaneSession(paneId) === current;
}

function trayCommand(cwd: string, sessionId: string): string {
  const pythonTray = join(__dirname, "..", "python", "tray.py");
  return `python3 "${pythonTray}" "${cwd}" "${sessionId}"`;
}

export function splitAndLaunchTray(cwd: string, sessionId: string = ""): string {
  const paneId = run(
    `tmux split-window -v -l 10 -P -F '#{pane_id}' -c '${cwd}' '${trayCommand(cwd, sessionId)}'`
  );
  run("tmux select-pane -U");
  return paneId;
}

function sidecarCommand(cwd: string, sessionId: string = ""): string {
  const pythonSidecar = join(__dirname, "..", "python", "sidecar.py");
  return `python3 "${pythonSidecar}" "${cwd}" "${sessionId}"`;
}

export function splitAndLaunchSidecar(cwd: string, sessionId: string = ""): string {
  const paneId = run(
    `tmux split-window -h -l 40% -P -F '#{pane_id}' -c '${cwd}' '${sidecarCommand(cwd, sessionId)}'`
  );
  run("tmux select-pane -L");
  return paneId;
}

export function launchNewSession(cwd: string, sessionId: string = ""): void {
  const sessionName = "latch";
  run(`tmux new-session -d -s ${sessionName} -c '${cwd}'`);
  run(
    `tmux split-window -h -l 40% -t ${sessionName} -c '${cwd}' '${sidecarCommand(cwd, sessionId)}'`
  );
  run(`tmux select-pane -t ${sessionName}:.0`);

  const attach = spawn("tmux", ["attach-session", "-t", sessionName], {
    stdio: "inherit",
  });
  attach.on("exit", () => process.exit(0));
}

function uniqueSessionName(): string {
  const suffix = createHash("sha256").update(Date.now().toString()).digest("hex").slice(0, 6);
  return `latch-${suffix}`;
}

export function launchWithAgent(cwd: string, agentCommand: string): never {
  if (isInsideTmux()) {
    // Already in tmux — run the agent in the current pane and block
    const result = spawnSync(agentCommand, [], {
      cwd,
      stdio: "inherit",
    });
    process.exit(result.status ?? 0);
  } else {
    const sessionName = uniqueSessionName();
    const loadingPy = join(__dirname, "..", "python", "loading.py");
    run(`tmux new-session -d -s ${sessionName} -c '${cwd}' 'python3 "${loadingPy}" "${agentCommand}"'`);

    const result = spawnSync("tmux", ["attach-session", "-t", sessionName], {
      stdio: "inherit",
    });
    process.exit(result.status ?? 0);
  }
}

export function switchClientToAgentSession(cwd: string, agentCommand: string): never {
  if (!isInsideTmux()) {
    launchWithAgent(cwd, agentCommand);
  }

  const sessionName = uniqueSessionName();
  const loadingPy = join(__dirname, "..", "python", "loading.py");
  run(`tmux new-session -d -s ${sessionName} -c '${cwd}' 'python3 "${loadingPy}" "${agentCommand}"'`);
  run(`tmux switch-client -t ${sessionName}`);
  process.exit(0);
}

export function openAgentInTargetPane(originCwd: string, projectCwd: string, agentCommand: string): never {
  if (!isInsideTmux()) {
    launchWithAgent(projectCwd, agentCommand);
  }

  const targetPane = getProjectTargetPaneId(originCwd) || getCurrentPaneId();
  if (!targetPane) {
    launchWithAgent(projectCwd, agentCommand);
  }

  const loadingPy = join(__dirname, "..", "python", "loading.py");
  run(`tmux respawn-pane -k -t ${targetPane} -c '${projectCwd}' 'python3 "${loadingPy}" "${agentCommand}"'`);
  run(`tmux select-pane -t ${targetPane}`);
  process.exit(0);
}

export function openCommandInNewWindow(cwd: string, command: string): never {
  if (!isInsideTmux()) {
    const result = spawnSync(command, [], {
      cwd,
      stdio: "inherit",
      shell: true,
    });
    process.exit(result.status ?? 0);
  }

  const sessionName = getCurrentTmuxSession();
  const targetFlag = sessionName ? `-t ${sessionName}` : "";
  const windowId = run(
    `tmux new-window -P -F '#{window_id}' ${targetFlag} -c '${cwd}' '${command}'`
  );
  run(`tmux select-window -t ${windowId}`);
  process.exit(0);
}

function quoteAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function openCommandInNewTerminal(cwd: string, command: string): never {
  if (process.platform === "darwin" && detectTerminal() === "ghostty") {
    const result = spawnSync(
      "osascript",
      [
        "-e", 'tell application "Ghostty"',
        "-e", "activate",
        "-e", "set cfg to new surface configuration",
        "-e", `set initial working directory of cfg to "${quoteAppleScriptString(cwd)}"`,
        "-e", "set win to front window",
        "-e", "set newTab to new tab in win with configuration cfg",
        "-e", "set term to focused terminal of newTab",
        "-e", `input text "${quoteAppleScriptString(command)}" to term`,
        "-e", 'send key "enter" to term',
        "-e", "end tell",
      ],
      { stdio: "inherit" }
    );

    process.exit(result.status ?? 0);
  }

  openCommandInNewWindow(cwd, command);
}

// ── tray pane tracking ──────────────────────────────────────────────────────

function trayPanePath(cwd: string, sessionId: string = ""): string {
  return paneStatePath(cwd + sessionId, "tray-pane");
}

export function saveTrayPaneId(cwd: string, sessionId: string, paneId: string): void {
  writePaneState(trayPanePath(cwd, sessionId), paneId);
}

export function getTrayPaneId(cwd: string, sessionId: string = ""): string | null {
  return readPaneState(trayPanePath(cwd, sessionId));
}

// ── sidecar toggle ──────────────────────────────────────────────────────────

export function focusOrOpenSidecar(cwd: string, sessionId: string = ""): void {
  const paneId = getSidecarPaneId(cwd, sessionId);
  if (paneId) {
    try {
      run(`tmux display-message -t ${paneId} -p ''`);
      // Pane is alive — switch focus to it
      run(`tmux select-pane -t ${paneId}`);
      return;
    } catch {
      // Pane is dead — clean up the stale ID file
      removePaneState(sidecarPanePath(cwd, sessionId));
    }
  }
  // Open a new sidecar
  const newPaneId = splitAndLaunchSidecar(cwd, sessionId);
  saveSidecarPaneId(cwd, sessionId, newPaneId);
}

// ── chat popup ──────────────────────────────────────────────────────────────

function chatCommand(cwd: string, sessionId: string, claudePane: string): string {
  const pythonChat = join(__dirname, "..", "python", "chat.py");
  return `python3 "${pythonChat}" "${cwd}" "${sessionId}" "${claudePane}"`;
}

export function openChatPopup(cwd: string, sessionId: string): void {
  // Capture the active pane ID so chat.py can send /resume commands to it
  const claudePane = run(`tmux display-message -p '#{pane_id}'`);
  run(
    `tmux display-popup -w 90% -h 90% -E '${chatCommand(cwd, sessionId, claudePane)}'`
  );
}

function projectsCommand(cwd: string): string {
  const pythonProjects = join(__dirname, "..", "python", "projects.py");
  return `python3 "${pythonProjects}" "${cwd}"`;
}

export function openProjectsPopup(cwd: string): void {
  const currentPane = getCurrentPaneId();
  if (currentPane) saveProjectTargetPaneId(cwd, currentPane);
  run(
    `tmux display-popup -w 75% -h 65% -E '${projectsCommand(cwd)}'`
  );
}

export function splitAndLaunchWorkspaces(cwd: string): string {
  return run(
    `tmux split-window -h -b -l 30% -P -F '#{pane_id}' -c '${cwd}' '${projectsCommand(cwd)}'`
  );
}

export function focusOrOpenWorkspaces(cwd: string): void {
  const currentPane = getCurrentPaneId();
  const paneId = getWorkspacesPaneId(cwd);
  if (paneId) {
    if (currentPane && currentPane !== paneId) saveProjectTargetPaneId(cwd, currentPane);
    try {
      run(`tmux display-message -t ${paneId} -p ''`);
      run(`tmux select-pane -t ${paneId}`);
      return;
    } catch {
      removePaneState(workspacesPanePath(cwd));
    }
  }

  if (currentPane) saveProjectTargetPaneId(cwd, currentPane);
  const newPaneId = splitAndLaunchWorkspaces(cwd);
  saveWorkspacesPaneId(cwd, newPaneId);
}

// ── session cleanup ─────────────────────────────────────────────────────────

/** Kill sidecar and tray panes for a given session, clean up pane ID files */
export function killLatchPanes(cwd: string, sessionId: string = ""): void {
  const sidecarPane = getSidecarPaneId(cwd, sessionId);
  const trayPane = getTrayPaneId(cwd, sessionId);

  for (const paneId of [sidecarPane, trayPane]) {
    if (!paneId) continue;
    try {
      execSync(`tmux kill-pane -t ${paneId} 2>/dev/null`);
    } catch {}
  }

  // Clean up pane ID files
  for (const path of [sidecarPanePath(cwd, sessionId), trayPanePath(cwd, sessionId)]) {
    removePaneState(path);
  }
}
