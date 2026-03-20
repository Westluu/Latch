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

export function getSessionName(): string {
  return run("tmux display-message -p '#S'");
}

function trayCommand(cwd: string): string {
  const distTray = join(__dirname, "tray.js");
  if (existsSync(distTray)) return `node "${distTray}" "${cwd}"`;
  const rootDistTray = join(__dirname, "..", "dist", "tray.js");
  if (existsSync(rootDistTray)) return `node "${rootDistTray}" "${cwd}"`;
  const tsxBin = join(__dirname, "..", "node_modules", ".bin", "tsx");
  const traySrc = join(__dirname, "tray.tsx");
  return `"${tsxBin}" "${traySrc}" "${cwd}"`;
}

export function splitAndLaunchTray(cwd: string): string {
  // Split vertically (top/bottom), tray takes 10 lines at the bottom
  const paneId = run(
    `tmux split-window -v -l 10 -P -F '#{pane_id}' -c '${cwd}' '${trayCommand(cwd)}'`
  );
  // Move focus back to the pane above
  run("tmux select-pane -U");
  return paneId;
}

function sidecarCommand(cwd: string): string {
  // When bundled, __dirname is dist/ and sidecar.js is right next to us.
  // When run via tsx in development, __dirname is src/ and sidecar.js doesn't
  // exist there — fall back to the dist bundle or tsx.
  const distSidecar = join(__dirname, "sidecar.js");
  if (existsSync(distSidecar)) {
    return `node "${distSidecar}" "${cwd}"`;
  }
  // Dev fallback: use the dist build from the project root if available
  const rootDistSidecar = join(__dirname, "..", "dist", "sidecar.js");
  if (existsSync(rootDistSidecar)) {
    return `node "${rootDistSidecar}" "${cwd}"`;
  }
  // Last resort: run the source directly via tsx
  const tsxBin = join(__dirname, "..", "node_modules", ".bin", "tsx");
  const sidecarSrc = join(__dirname, "sidecar.tsx");
  return `"${tsxBin}" "${sidecarSrc}" "${cwd}"`;
}

export function splitAndLaunchSidecar(cwd: string): string {
  // Split horizontally (left/right), sidecar takes 40% width on the right
  const paneId = run(
    `tmux split-window -h -l 40% -P -F '#{pane_id}' -c '${cwd}' '${sidecarCommand(cwd)}'`
  );
  // Move focus back to the left pane (the user's shell)
  run("tmux select-pane -L");
  return paneId;
}

export function launchNewSession(cwd: string): void {
  const sessionName = "latch";

  // Create session with user's shell
  run(`tmux new-session -d -s ${sessionName} -c '${cwd}'`);
  // Split and launch sidecar on the right
  run(
    `tmux split-window -h -l 40% -t ${sessionName} -c '${cwd}' '${sidecarCommand(cwd)}'`
  );
  // Focus the left pane
  run(`tmux select-pane -t ${sessionName}:.0`);

  // Attach to session (this blocks until user detaches/exits)
  const attach = spawn("tmux", ["attach-session", "-t", sessionName], {
    stdio: "inherit",
  });
  attach.on("exit", () => process.exit(0));
}

export function killPane(paneId: string): void {
  try {
    run(`tmux kill-pane -t ${paneId}`);
  } catch {
    // Pane may already be gone
  }
}
