#!/usr/bin/env node
// Claude Code SessionStart hook for Latch
// Re-launches sidecar + tray if resuming a session that had edits,
// then replays all previous turns into the tray via IPC.

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { splitAndLaunchSidecar, saveSidecarPaneId, saveTrayPaneId, getSidecarPaneId, isPaneInCurrentSession } from "./tmux.js";
import { getTraySocketPath, sendTrayMessage } from "./ipc.js";
import { sessionIdFromTranscript, hasEdits, parseAllTurns } from "./transcript.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let input = "";
const timeout = setTimeout(() => process.exit(0), 10000);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", async () => {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input);
    const cwd = data.cwd || process.cwd();
    const transcriptPath = data.transcript_path as string | undefined;

    if (!process.env.TMUX || !transcriptPath || !existsSync(transcriptPath)) {
      process.exit(0);
    }

    // Quick regex check — no edits means nothing to restore
    if (!hasEdits(transcriptPath)) {
      process.exit(0);
    }

    const sessionId = sessionIdFromTranscript(transcriptPath);

    // Launch sidecar if not already running in the current tmux session
    const existingPane = getSidecarPaneId(cwd, sessionId);
    const sidecarAlive = existingPane ? isPaneInCurrentSession(existingPane) : false;

    if (!sidecarAlive) {
      const paneId = splitAndLaunchSidecar(cwd, sessionId);
      saveSidecarPaneId(cwd, sessionId, paneId);
    }

    // Launch tray below sidecar
    const sidecarPane = getSidecarPaneId(cwd, sessionId);
    const targetFlag = sidecarPane ? `-b -t ${sidecarPane}` : "";
    const trayPy = resolve(__dirname, "..", "python", "tray.py");
    const trayCmd = `tmux split-window -v -l 10 -P -F '#{pane_id}' ${targetFlag} -c ${JSON.stringify(cwd)} 'python3 "${trayPy}" "${cwd}" "${sessionId}"'`;
    const trayPaneId = execSync(trayCmd, { encoding: "utf-8" }).trim();
    saveTrayPaneId(cwd, sessionId, trayPaneId);

    // Wait for tray socket to be ready
    const traySocket = getTraySocketPath(cwd, sessionId);
    for (let i = 0; i < 8; i++) {
      await sleep(500);
      if (existsSync(traySocket)) break;
    }

    // Replay all previous turns into the tray
    if (existsSync(traySocket)) {
      const turns = parseAllTurns(cwd, transcriptPath, sessionId);
      for (const turn of turns) {
        await sendTrayMessage(cwd, sessionId, {
          type: "turn",
          label: turn.label,
          files: turn.files,
          diffStats: turn.diffStats,
        });
      }
    }

  } catch {}
  process.exit(0);
});
