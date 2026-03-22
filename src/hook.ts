#!/usr/bin/env node
// Claude Code PostToolUse hook for Latch
// Receives tool use data via stdin, sends file path to sidecar via IPC

import { existsSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { sendIpcMessage, getSocketPath } from "./ipc.js";
import { splitAndLaunchSidecar, saveSidecarPaneId } from "./tmux.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

import { appendFileSync } from "node:fs";
const LOG = "/tmp/latch-hook.log";
const dbg = (...args: unknown[]) => {
  try { appendFileSync(LOG, `[${new Date().toISOString()}] ${args.join(" ")}\n`); } catch {}
};

function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((res) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => { socket.destroy(); res(false); }, 1000);
    socket.on("connect", () => { clearTimeout(timer); socket.destroy(); res(true); });
    socket.on("error", () => { clearTimeout(timer); res(false); });
  });
}

let input = "";
const timeout = setTimeout(() => process.exit(0), 5000);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", async () => {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input);
    const filePath = data.tool_input?.file_path;
    dbg("filePath:", filePath);
    if (!filePath) process.exit(0);

    const cwd = data.cwd || process.cwd();
    const relative = filePath.startsWith(cwd + "/")
      ? filePath.slice(cwd.length + 1)
      : filePath;

    dbg("cwd:", cwd, "relative:", relative, "TMUX:", process.env.TMUX);

    if (process.env.TMUX) {
      const sidecarSocket = getSocketPath(cwd);
      let alive = false;
      if (existsSync(sidecarSocket)) {
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
        dbg("launching sidecar via splitAndLaunchSidecar");
        try {
          const paneId = splitAndLaunchSidecar(cwd);
          saveSidecarPaneId(cwd, paneId);
          dbg("sidecar pane:", paneId);
        } catch (e) {
          dbg("sidecar launch failed:", e);
        }
        for (let i = 0; i < 8; i++) {
          await sleep(500);
          if (existsSync(sidecarSocket)) { dbg("socket ready after", i + 1, "attempts"); break; }
        }
        dbg("socket exists after wait:", existsSync(sidecarSocket));
      }
    }

    await sendIpcMessage(cwd, { type: "open", filePath: relative });
    dbg("message sent");
  } catch (err) {
    dbg("ERROR:", err);
  }
  process.exit(0);
});
