import { existsSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { getSidecarSocketPath } from "./ipc.js";
import { splitAndLaunchSidecar, saveSidecarPaneId } from "./tmux.js";

type DebugLogger = (...args: unknown[]) => void;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);

    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function ensureSidecarReady(
  cwd: string,
  sessionId: string,
  dbg: DebugLogger = () => {},
  waitAttempts: number = 8,
  waitMs: number = 500
): Promise<string> {
  const sidecarSocket = getSidecarSocketPath(cwd, sessionId);
  let alive = false;
  const socketExists = existsSync(sidecarSocket);

  if (socketExists) {
    alive = await isSocketAlive(sidecarSocket);
    dbg("socket:", sidecarSocket, "exists: true, alive:", alive);
    if (!alive) {
      dbg("removing stale socket");
      try { unlinkSync(sidecarSocket); } catch {}
    }
  } else {
    dbg("socket:", sidecarSocket, "exists: false");
  }

  if (!alive) {
    dbg("launching sidecar");
    try {
      const paneId = splitAndLaunchSidecar(cwd, sessionId);
      saveSidecarPaneId(cwd, sessionId, paneId);
      dbg("sidecar pane:", paneId);
    } catch (error) {
      dbg("sidecar launch failed:", error);
    }

    for (let attempt = 0; attempt < waitAttempts; attempt += 1) {
      await sleep(waitMs);
      if (existsSync(sidecarSocket)) {
        dbg("socket ready after", attempt + 1, "attempts");
        break;
      }
    }
  }

  dbg("socket exists after wait:", existsSync(sidecarSocket));
  return sidecarSocket;
}
