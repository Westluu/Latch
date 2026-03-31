import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

function sidecarPanePath(cwd: string, sessionId: string = ""): string {
  const hash = createHash("sha256").update(cwd + sessionId).digest("hex").slice(0, 12);
  const dir = join(tmpdir(), "latch");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}-sidecar-pane.txt`);
}

function workspacesPanePath(cwd: string): string {
  const hash = createHash("sha256").update(`${cwd}:workspaces`).digest("hex").slice(0, 12);
  const dir = join(tmpdir(), "latch");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}-workspaces-pane.txt`);
}

export function saveSidecarPaneId(cwd: string, sessionId: string, paneId: string): void {
  writeFileSync(sidecarPanePath(cwd, sessionId), paneId);
}

export function getSidecarPaneId(cwd: string, sessionId: string = ""): string | null {
  const p = sidecarPanePath(cwd, sessionId);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf-8").trim() || null;
}

export function saveWorkspacesPaneId(cwd: string, paneId: string): void {
  writeFileSync(workspacesPanePath(cwd), paneId);
}

export function getWorkspacesPaneId(cwd: string): string | null {
  const p = workspacesPanePath(cwd);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf-8").trim() || null;
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

// ── tray pane tracking ──────────────────────────────────────────────────────

function trayPanePath(cwd: string, sessionId: string = ""): string {
  const hash = createHash("sha256").update(cwd + sessionId).digest("hex").slice(0, 12);
  const dir = join(tmpdir(), "latch");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}-tray-pane.txt`);
}

export function saveTrayPaneId(cwd: string, sessionId: string, paneId: string): void {
  writeFileSync(trayPanePath(cwd, sessionId), paneId);
}

export function getTrayPaneId(cwd: string, sessionId: string = ""): string | null {
  const p = trayPanePath(cwd, sessionId);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf-8").trim() || null;
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
      try { unlinkSync(sidecarPanePath(cwd, sessionId)); } catch {}
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
  const paneId = getWorkspacesPaneId(cwd);
  if (paneId) {
    try {
      run(`tmux display-message -t ${paneId} -p ''`);
      run(`tmux select-pane -t ${paneId}`);
      return;
    } catch {
      try { unlinkSync(workspacesPanePath(cwd)); } catch {}
    }
  }

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
    try { unlinkSync(path); } catch {}
  }
}
