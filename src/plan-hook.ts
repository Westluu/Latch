#!/usr/bin/env node
// Claude Code PostToolUse hook for ExitPlanMode.
// Fires when Claude exits plan mode. Ensures the sidecar is open and sends
// the plan file path so it switches to the Plans tab.

import { existsSync } from "node:fs";
import { sendSidecarMessage } from "./ipc.js";
import { ensureSidecarReady } from "./sidecar-runtime.js";
import { sessionIdFromTranscript, planFileFromTranscript } from "./transcript.js";
import { createFileLogger, readJsonFromStdin, sleep } from "./hook-runtime.js";

const LOG = "/tmp/latch-plan-hook.log";
const dbg = createFileLogger(LOG);

void (async () => {
  const data = await readJsonFromStdin(10000);
  try {
    dbg("tool_name:", data?.tool_name);

    const cwd = (data?.cwd as string) || process.cwd();
    const transcriptPath = data?.transcript_path as string | undefined;
    const sessionId = transcriptPath ? sessionIdFromTranscript(transcriptPath) : "";
    const toolInput = data?.tool_input as Record<string, unknown> | undefined;

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
    await ensureSidecarReady(cwd, sessionId, dbg);

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
})();
