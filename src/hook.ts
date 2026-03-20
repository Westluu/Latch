#!/usr/bin/env node
// Claude Code PostToolUse hook for Latch
// Receives tool use data via stdin, sends file path to sidecar via IPC

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { sendIpcMessage } from "./ipc.js";

function getPendingFilePath(cwd: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  const dir = join(tmpdir(), "latch");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}-pending.txt`);
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
    if (!filePath) process.exit(0);

    // Convert absolute path to relative path based on cwd
    const cwd = data.cwd || process.cwd();
    const relative = filePath.startsWith(cwd + "/")
      ? filePath.slice(cwd.length + 1)
      : filePath;

    // Track file for the current pending turn
    appendFileSync(getPendingFilePath(cwd), relative + "\n");

    await sendIpcMessage(cwd, { type: "open", filePath: relative });
  } catch {
    // Silently fail — don't break Claude Code
  }
  process.exit(0);
});
