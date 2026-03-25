#!/usr/bin/env node
// Claude Code PostToolUse hook for Latch
// Receives tool use data via stdin, sends file path to sidecar via IPC

import { existsSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { homedir } from "node:os";
import { sendSidecarMessage, getSidecarSocketPath } from "./ipc.js";
import { splitAndLaunchSidecar, saveSidecarPaneId } from "./tmux.js";
import { sessionIdFromTranscript } from "./transcript.js";

const PLANS_DIR = join(homedir(), ".claude", "plans");

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
    const transcriptPath = data.transcript_path as string | undefined;
    const sessionId = transcriptPath ? sessionIdFromTranscript(transcriptPath) : "";
    const relative = filePath.startsWith(cwd + "/")
      ? filePath.slice(cwd.length + 1)
      : filePath;

    dbg("cwd:", cwd, "relative:", relative, "sessionId:", sessionId, "TMUX:", process.env.TMUX);

    if (process.env.TMUX) {
      const sidecarSocket = getSidecarSocketPath(cwd, sessionId);
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
          const paneId = splitAndLaunchSidecar(cwd, sessionId);
          saveSidecarPaneId(cwd, sessionId, paneId);
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

    // Plan file writes get a dedicated IPC type so the sidecar can switch tabs
    if (filePath.startsWith(PLANS_DIR + "/")) {
      await sendSidecarMessage(cwd, sessionId, { type: "plan", planFilePath: filePath });
      dbg("plan message sent:", filePath);
    } else {
      await sendSidecarMessage(cwd, sessionId, { type: "open", filePath: relative });
      dbg("message sent");
    }
  } catch (err) {
    dbg("ERROR:", err);
  }
  process.exit(0);
});
