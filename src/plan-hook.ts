#!/usr/bin/env node
// Claude Code PostToolUse hook for ExitPlanMode.
// Fires when Claude exits plan mode. Ensures the sidecar is open and sends
// the plan file path so it switches to the Plans tab.

import { existsSync, appendFileSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { sendSidecarMessage, getSidecarSocketPath } from "./ipc.js";
import { splitAndLaunchSidecar, saveSidecarPaneId } from "./tmux.js";
import { sessionIdFromTranscript, planFileFromTranscript } from "./transcript.js";

const LOG = "/tmp/latch-plan-hook.log";
const dbg = (...args: unknown[]) => {
  try { appendFileSync(LOG, `[${new Date().toISOString()}] ${args.join(" ")}\n`); } catch {}
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((res) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => { socket.destroy(); res(false); }, 1000);
    socket.on("connect", () => { clearTimeout(timer); socket.destroy(); res(true); });
    socket.on("error", () => { clearTimeout(timer); res(false); });
  });
}

let input = "";
const timeout = setTimeout(() => process.exit(0), 10000);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", async () => {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input);
    dbg("tool_name:", data.tool_name);

    const cwd = (data.cwd as string) || process.cwd();
    const transcriptPath = data.transcript_path as string | undefined;
    const sessionId = transcriptPath ? sessionIdFromTranscript(transcriptPath) : "";
    const toolInput = data.tool_input as Record<string, unknown> | undefined;

    // Resolve plan file path: use explicit field first, fall back to slug-derived path
    const planFilePath =
      (toolInput?.planFilePath as string | undefined) ??
      (transcriptPath ? planFileFromTranscript(transcriptPath) : null);

    dbg("planFilePath:", planFilePath, "sessionId:", sessionId, "TMUX:", process.env.TMUX);

    if (!planFilePath) {
      dbg("EXIT: could not resolve planFilePath");
      process.exit(0);
    }

    if (!existsSync(planFilePath)) {
      dbg("EXIT: plan file does not exist yet:", planFilePath);
      process.exit(0);
    }

    if (!process.env.TMUX) {
      dbg("EXIT: not in tmux");
      process.exit(0);
    }

    // Ensure sidecar is running
    const sidecarSocket = getSidecarSocketPath(cwd, sessionId);
    let alive = false;
    if (existsSync(sidecarSocket)) {
      alive = await isSocketAlive(sidecarSocket);
      if (!alive) {
        dbg("removing stale socket");
        try { unlinkSync(sidecarSocket); } catch {}
      }
    }

    if (!alive) {
      dbg("launching sidecar");
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
    }

    // Retry send until socket accepts
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      try {
        await sendSidecarMessage(cwd, sessionId, { type: "plan", planFilePath });
        dbg("IPC sent successfully on attempt", i + 1);
        break;
      } catch (e) {
        dbg("IPC attempt", i + 1, "failed:", e);
      }
    }
  } catch (err) {
    dbg("ERROR:", err);
  }
  process.exit(0);
});
