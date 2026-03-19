#!/usr/bin/env node
// Claude Code PostToolUse hook for Latch
// Receives tool use data via stdin, sends file path to sidecar via IPC

import { sendIpcMessage } from "./ipc.js";

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

    await sendIpcMessage({ type: "open", filePath: relative });
  } catch {
    // Silently fail — don't break Claude Code
  }
  process.exit(0);
});
