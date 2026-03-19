import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

export function splitAndLaunchSidecar(cwd: string): string {
  const sidecarScript = join(__dirname, "sidecar.tsx");
  // Split horizontally (left/right), sidecar takes 40% width on the right
  const paneId = run(
    `tmux split-window -h -l 40% -P -F '#{pane_id}' -c '${cwd}' 'npx tsx ${sidecarScript} ${cwd}'`
  );
  // Move focus back to the left pane (the user's shell)
  run("tmux select-pane -L");
  return paneId;
}

export function launchNewSession(cwd: string): void {
  const sidecarScript = join(__dirname, "sidecar.tsx");
  const sessionName = "latch";

  // Create session with user's shell
  run(`tmux new-session -d -s ${sessionName} -c '${cwd}'`);
  // Split and launch sidecar on the right
  run(
    `tmux split-window -h -l 40% -t ${sessionName} -c '${cwd}' 'npx tsx ${sidecarScript} ${cwd}'`
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
