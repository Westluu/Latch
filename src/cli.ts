#!/usr/bin/env node

import { isInsideTmux, splitAndLaunchSidecar, launchNewSession } from "./tmux.js";
import { sendIpcMessage } from "./ipc.js";
import { initHook, removeHook } from "./init.js";

const args = process.argv.slice(2);
const command = args[0];

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
latch — terminal sidecar for agent workflows

Usage:
  latch              Open sidecar in a tmux pane
  latch open <file>  Open a file in the sidecar preview
  latch init         Add Claude Code hook (auto-open files on edit)
  latch remove       Remove the Claude Code hook
  latch --help       Show this help message
  latch --version    Show version
`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log("latch v0.1.0");
  process.exit(0);
}

if (command === "init") {
  initHook();
  process.exit(0);
}

if (command === "remove") {
  removeHook();
  process.exit(0);
}

if (command === "open") {
  const filePath = args[1];
  if (!filePath) {
    console.error("Usage: latch open <file>");
    process.exit(1);
  }

  const cwd = process.cwd();

  // Try sending first; if sidecar isn't running, launch it and retry
  try {
    const response = await sendIpcMessage({ type: "open", filePath });
    console.log(response);
    process.exit(0);
  } catch {
    // Sidecar not running — launch it
    if (isInsideTmux()) {
      console.log("Latch: starting sidecar...");
      splitAndLaunchSidecar(cwd);
    } else {
      console.error("Latch: not in tmux. Run 'latch' first to start the sidecar.");
      process.exit(1);
    }

    // Wait for the socket to become available (up to 5 seconds)
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      try {
        const response = await sendIpcMessage({ type: "open", filePath });
        console.log(response);
        process.exit(0);
      } catch {
        // Keep waiting
      }
    }
    console.error("Latch: timed out waiting for sidecar to start.");
    process.exit(1);
  }
}

const cwd = process.cwd();

if (isInsideTmux()) {
  console.log("Latch: opening sidecar pane...");
  const paneId = splitAndLaunchSidecar(cwd);
  console.log(`Latch: sidecar running in pane ${paneId}`);
} else {
  console.log("Latch: not inside tmux, creating new session...");
  launchNewSession(cwd);
}
