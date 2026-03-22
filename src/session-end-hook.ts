#!/usr/bin/env node
// Claude Code SessionEnd hook for Latch
// Kills sidecar and tray panes when the Claude Code session ends.

import { killLatchPanes } from "./tmux.js";

let input = "";
const timeout = setTimeout(() => process.exit(0), 5000);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input);
    const cwd = data.cwd || process.cwd();
    killLatchPanes(cwd);
  } catch {}
  process.exit(0);
});
