#!/usr/bin/env node
// Claude Code SessionEnd hook for Latch
// Kills sidecar and tray panes when the Claude Code session ends.

import { killLatchPanes } from "./tmux.js";
import { sessionIdFromTranscript } from "./transcript.js";
import { readJsonFromStdin } from "./hook-runtime.js";

void (async () => {
  const data = await readJsonFromStdin(5000);
  try {
    const cwd = (data?.cwd as string) || process.cwd();
    const transcriptPath = data?.transcript_path as string | undefined;
    const sessionId = transcriptPath ? sessionIdFromTranscript(transcriptPath) : "";
    killLatchPanes(cwd, sessionId);
  } catch {}
  process.exit(0);
})();
