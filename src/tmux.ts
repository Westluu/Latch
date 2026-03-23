import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

function sidecarPanePath(cwd: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  const dir = join(tmpdir(), "latch");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}-sidecar-pane.txt`);
}

export function saveSidecarPaneId(cwd: string, paneId: string): void {
  writeFileSync(sidecarPanePath(cwd), paneId);
}

export function getSidecarPaneId(cwd: string): string | null {
  const p = sidecarPanePath(cwd);
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

function sidecarCommand(cwd: string): string {
  const pythonSidecar = join(__dirname, "..", "python", "sidecar.py");
  return `python3 "${pythonSidecar}" "${cwd}"`;
}

export function splitAndLaunchSidecar(cwd: string): string {
  const paneId = run(
    `tmux split-window -h -l 40% -P -F '#{pane_id}' -c '${cwd}' '${sidecarCommand(cwd)}'`
  );
  run("tmux select-pane -L");
  return paneId;
}

export function launchNewSession(cwd: string): void {
  const sessionName = "latch";
  run(`tmux new-session -d -s ${sessionName} -c '${cwd}'`);
  run(
    `tmux split-window -h -l 40% -t ${sessionName} -c '${cwd}' '${sidecarCommand(cwd)}'`
  );
  run(`tmux select-pane -t ${sessionName}:.0`);

  const attach = spawn("tmux", ["attach-session", "-t", sessionName], {
    stdio: "inherit",
  });
  attach.on("exit", () => process.exit(0));
}

function sessionExists(name: string): boolean {
  try {
    run(`tmux has-session -t ${name}`);
    return true;
  } catch {
    return false;
  }
}

export function launchWithAgent(cwd: string, agentCommand: string): never {
  const sessionName = "latch";

  if (isInsideTmux()) {
    // Already in tmux — run the agent in the current pane and block
    const result = spawnSync(agentCommand, [], {
      cwd,
      stdio: "inherit",
    });
    process.exit(result.status ?? 0);
  } else {
    if (!sessionExists(sessionName)) {
      const wrappedCommand = `echo "Latch — starting ${agentCommand}..." && ${agentCommand}`;
      run(`tmux new-session -d -s ${sessionName} -c '${cwd}' '${wrappedCommand}'`);
    }

    const result = spawnSync("tmux", ["attach-session", "-t", sessionName], {
      stdio: "inherit",
    });
    process.exit(result.status ?? 0);
  }
}

// ── tray pane tracking ──────────────────────────────────────────────────────

function trayPanePath(cwd: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  const dir = join(tmpdir(), "latch");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}-tray-pane.txt`);
}

export function saveTrayPaneId(cwd: string, paneId: string): void {
  writeFileSync(trayPanePath(cwd), paneId);
}

export function getTrayPaneId(cwd: string): string | null {
  const p = trayPanePath(cwd);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf-8").trim() || null;
}

// ── session cleanup ─────────────────────────────────────────────────────────

/** Kill sidecar and tray panes for a given cwd, clean up pane ID files */
export function killLatchPanes(cwd: string): void {
  const sidecarPane = getSidecarPaneId(cwd);
  const trayPane = getTrayPaneId(cwd);

  for (const paneId of [sidecarPane, trayPane]) {
    if (!paneId) continue;
    try {
      execSync(`tmux kill-pane -t ${paneId} 2>/dev/null`);
    } catch {}
  }

  // Clean up pane ID files
  for (const path of [sidecarPanePath(cwd), trayPanePath(cwd)]) {
    try { unlinkSync(path); } catch {}
  }
}
