#!/usr/bin/env node
// Claude Code PostToolUse hook for Latch.
// Receives tool use data via stdin, ensures the sidecar is ready, then sends a file path over IPC.

import { join } from "node:path";
import { homedir } from "node:os";
import { sendSidecarMessage } from "./ipc.js";
import { ensureSidecarReady } from "./sidecar-runtime.js";
import { sessionIdFromTranscript } from "./transcript.js";

const PLANS_DIR = join(homedir(), ".claude", "plans");

import { appendFileSync } from "node:fs";
const LOG = "/tmp/latch-hook.log";
const dbg = (...args: unknown[]) => {
  try { appendFileSync(LOG, `[${new Date().toISOString()}] ${args.join(" ")}\n`); } catch {}
};

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
      await ensureSidecarReady(cwd, sessionId, dbg);
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
