#!/usr/bin/env node

import { isInsideTmux, splitAndLaunchSidecar, splitAndLaunchTray, launchNewSession, launchWithAgent, saveSidecarPaneId, focusOrOpenSidecar, openChatPopup } from "./tmux.js";
import { sendSidecarMessage } from "./ipc.js";
import { initHook, removeHook } from "./init.js";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const command = args[0];

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
latch — terminal sidecar for agent-driven CLI workflows

Usage:
  latch claude       Launch Claude Code in a tmux session with Latch
  latch open <file>  Open a file in the Latch preview
  latch toggle       Focus sidecar if open, or open it if closed
  latch chat         Open conversation viewer as a floating popup
  latch init         Add Claude Code hooks and tmux keybinding (CMD+E)
  latch remove       Remove the Claude Code hooks and tmux keybinding
  latch --help       Show this help message
  latch --version    Show version
`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log("latch v0.1.0");
  process.exit(0);
}

const AGENTS: Record<string, string> = {
  claude: "claude",
};

if (command && command in AGENTS) {
  const cwd = process.cwd();
  launchWithAgent(cwd, AGENTS[command]);
  // launchWithAgent handles process exit internally
}

if (command === "init") {
  initHook();
  process.exit(0);
}

if (command === "toggle") {
  const cwd = process.cwd();
  if (!isInsideTmux()) {
    console.error("latch toggle: must be run inside a tmux session.");
    process.exit(1);
  }
  focusOrOpenSidecar(cwd, "");
  process.exit(0);
}

if (command === "chat") {
  const cwd = process.cwd();
  if (!isInsideTmux()) {
    console.error("latch chat: must be run inside a tmux session.");
    process.exit(1);
  }
  // Find the most recent transcript for this cwd
  const projectDir = cwd.replace(/\//g, "-");
  const projectPath = join(homedir(), ".claude", "projects", projectDir);
  let sessionId: string;
  try {
    const files = readdirSync(projectPath)
      .filter((f: string) => f.endsWith(".jsonl"))
      .map((f: string) => ({ name: f, mtime: statSync(join(projectPath, f)).mtimeMs }))
      .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
    if (files.length === 0) {
      console.error("latch chat: no Claude sessions found for this directory.");
      process.exit(1);
    }
    sessionId = files[0].name.replace(/\.jsonl$/, "");
  } catch {
    console.error("latch chat: no Claude sessions found for this directory.");
    console.error("  looked in:", projectPath);
    process.exit(1);
  }
  try {
    openChatPopup(cwd, sessionId);
  } catch (e: unknown) {
    console.error("latch chat: failed to open popup:", (e as Error).message);
    process.exit(1);
  }
  process.exit(0);
}

if (command === "tray") {
  const cwd = process.cwd();
  if (isInsideTmux()) {
    const paneId = splitAndLaunchTray(cwd);
    console.log(`Latch tray: running in pane ${paneId}`);
  } else {
    console.error("latch tray: must be run inside a tmux session.");
    process.exit(1);
  }
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
    const response = await sendSidecarMessage(cwd, "", { type: "open", filePath });
    console.log(response);
    process.exit(0);
  } catch {
    // Sidecar not running — launch it
    if (isInsideTmux()) {
      console.log("Latch: starting...");
      saveSidecarPaneId(cwd, "", splitAndLaunchSidecar(cwd));
    } else {
      console.error("Latch: not in tmux. Run 'latch' first to start.");
      process.exit(1);
    }

    // Wait for the socket to become available (up to 5 seconds)
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      try {
        const response = await sendSidecarMessage(cwd, "", { type: "open", filePath });
        console.log(response);
        process.exit(0);
      } catch {
        // Keep waiting
      }
    }
    console.error("Latch: timed out waiting to start.");
    process.exit(1);
  }
}

const cwd = process.cwd();

if (isInsideTmux()) {
  console.log("Latch: opening pane...");
  const paneId = splitAndLaunchSidecar(cwd);
  saveSidecarPaneId(cwd, "", paneId);
  console.log(`Latch: running in pane ${paneId}`);
} else {
  console.log("Latch: not inside tmux, creating new session...");
  launchNewSession(cwd);
}