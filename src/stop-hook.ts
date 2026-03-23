#!/usr/bin/env node
// Claude Code Stop hook for Latch
// Fires when Claude's turn ends. Parses the latest turn from the session
// transcript, then sends it to the tray via IPC.

import { existsSync, appendFileSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getTraySocketPath, sendTrayMessage } from "./ipc.js";
import { getSidecarPaneId, saveTrayPaneId, isPaneInCurrentSession } from "./tmux.js";
import { sessionIdFromTranscript, parseLastTurn } from "./transcript.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── helpers ──────────────────────────────────────────────────────────────────

const LOG = "/tmp/latch-debug.log";
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

function trayCommand(cwd: string, sessionId: string): string {
  const trayPy = resolve(__dirname, "..", "python", "tray.py");
  return `python3 "${trayPy}" "${cwd}" "${sessionId}"`;
}

// ── main ─────────────────────────────────────────────────────────────────────

let input = "";
const timeout = setTimeout(() => process.exit(0), 10000);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", async () => {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input) as Record<string, unknown>;
    const cwd = (data.cwd as string) || process.cwd();
    const transcriptPath = data.transcript_path as string | undefined;
    dbg("fired cwd=" + cwd + " transcript=" + transcriptPath);

    if (!transcriptPath || !existsSync(transcriptPath)) {
      dbg("EXIT: no transcript");
      process.exit(0);
    }

    const sessionId = sessionIdFromTranscript(transcriptPath);
    const turn = parseLastTurn(cwd, transcriptPath, sessionId);

    if (!turn) {
      dbg("EXIT: no files in turn");
      process.exit(0);
    }

    dbg("label=" + turn.label + " files=" + turn.files.length + " stats=+" + turn.diffStats.added + "/-" + turn.diffStats.removed);

    const traySocket = getTraySocketPath(cwd, sessionId);
    let trayAlive = false;
    if (existsSync(traySocket)) {
      trayAlive = await isSocketAlive(traySocket);
      dbg("traySocket exists, alive=" + trayAlive);
      if (!trayAlive) {
        try { unlinkSync(traySocket); } catch {}
      }
    }
    dbg("trayAlive=" + trayAlive + " TMUX=" + !!process.env.TMUX);

    if (!trayAlive && process.env.TMUX) {
      // Verify sidecar pane exists in the current tmux session before targeting it
      const savedPane = getSidecarPaneId(cwd, sessionId);
      const sidecarPane = savedPane && isPaneInCurrentSession(savedPane) ? savedPane : null;
      const targetFlag = sidecarPane ? `-b -t ${sidecarPane}` : "";
      const cmd = `tmux split-window -v -l 10 -P -F '#{pane_id}' ${targetFlag} -c ${JSON.stringify(cwd)} '${trayCommand(cwd, sessionId)}'`;
      dbg("launching tray:", cmd);
      try {
        const trayPaneId = execSync(cmd, { encoding: "utf-8" }).trim();
        dbg("tray pane:", trayPaneId);
        saveTrayPaneId(cwd, sessionId, trayPaneId);
      } catch (e) {
        dbg("tmux launch failed:", e);
      }
      for (let i = 0; i < 8; i++) {
        await sleep(500);
        if (existsSync(traySocket)) break;
      }
      dbg("socket after wait:", existsSync(traySocket));
    }

    await sendTrayMessage(cwd, sessionId, { type: "turn", label: turn.label, files: turn.files, diffStats: turn.diffStats });
    dbg("message sent");
  } catch (e) {
    dbg("CAUGHT ERROR:", e);
  }
  process.exit(0);
});
