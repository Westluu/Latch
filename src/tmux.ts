import { execSync, spawn } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
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
