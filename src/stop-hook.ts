#!/usr/bin/env node
// Claude Code Stop hook for Latch
// Fires when Claude's turn ends. Parses the latest turn from the session
// transcript, then sends it to the tray via IPC.

import { existsSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { getTraySocketPath, sendTrayMessage } from "./ipc.js";
import { getSidecarPaneId, saveTrayPaneId, isPaneInCurrentSession } from "./tmux.js";
import { sessionIdFromTranscript, parseLastTurn } from "./transcript.js";
import { createFileLogger, readJsonFromStdin, sleep } from "./hook-runtime.js";
import { pythonUiCommand } from "./python-ui.js";
import { isSocketAlive } from "./sidecar-runtime.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const LOG = "/tmp/latch-debug.log";
const dbg = createFileLogger(LOG);

function trayCommand(cwd: string, sessionId: string): string {
  return pythonUiCommand("tray.py", cwd, sessionId);
}

// ── main ─────────────────────────────────────────────────────────────────────

void (async () => {
  const data = await readJsonFromStdin(10000);
  try {
    const cwd = (data?.cwd as string) || process.cwd();
    const transcriptPath = data?.transcript_path as string | undefined;
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
    dbg("tray message sent");
  } catch (e) {
    dbg("CAUGHT ERROR:", e);
  }
  process.exit(0);
})();
