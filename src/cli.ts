#!/usr/bin/env node

import { isInsideTmux, splitAndLaunchSidecar, splitAndLaunchTray, launchNewSession, launchWithAgent, saveSidecarPaneId, focusOrOpenSidecar, focusOrOpenWorkspaces, openChatPopup, openProjectsPopup, switchClientToAgentSession } from "./tmux.js";
import { sendSidecarMessage } from "./ipc.js";
import { initHook, removeHook } from "./init.js";
import { addCurrentProject, addProject, getProject, listProjects, markProjectOpened, removeProject } from "./projects.js";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const command = args[0];

function printHelp(): void {
  console.log(`
latch — terminal sidecar for agent-driven CLI workflows

Usage:
  latch claude               Launch Claude Code in a tmux session with Latch
  latch <project>            Launch Claude Code for a saved project
  latch projects             Open the projects picker as a popup
  latch workspaces           Open the workspaces picker in a left pane
  latch project add --current <name>
  latch project add <path> <name>
  latch project open <name>
  latch project list
  latch project remove <name>
  latch open <file>          Open a file in the Latch preview
  latch toggle               Focus sidecar if open, or open it if closed
  latch chat                 Open conversation viewer as a floating popup
  latch init                 Add Claude Code hooks and tmux keybindings (CMD+E, CMD+P, CMD+S); installs tmux if missing
    --no-install-tmux        Skip automatic tmux installation during init
  latch remove               Remove the Claude Code hooks and tmux keybinding
  latch --help               Show this help message
  latch --version            Show version
`);
}

function exitWithError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

function openSavedProject(alias: string, options?: { popup?: boolean }): never {
  try {
    const project = getProject(alias);
    if (!project) {
      console.error(`Unknown project alias "${alias}".`);
      process.exit(1);
    }

    markProjectOpened(alias);
    if (options?.popup) {
      switchClientToAgentSession(project.path, "claude");
    }
    launchWithAgent(project.path, "claude");
  } catch (error: unknown) {
    exitWithError(error);
  }
}

function printProjectList(): void {
  const projects = listProjects();
  if (projects.length === 0) {
    console.log("No saved projects yet.");
    console.log("Add one with: latch project add --current <name>");
    return;
  }

  console.log("Projects");
  console.log("");
  for (const { alias, project } of projects) {
    console.log(`${alias.padEnd(16)} ${project.path}`);
  }
}

function handleProjectCommand(projectArgs: string[]): void {
  const subcommand = projectArgs[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(`
Usage:
  latch project add --current <name>
  latch project add <path> <name>
  latch project open <name>
  latch project list
  latch project remove <name>
`);
    process.exit(0);
  }

  if (subcommand === "list") {
    printProjectList();
    process.exit(0);
  }

  if (subcommand === "add") {
    if (projectArgs[1] === "--current") {
      const alias = projectArgs[2];
      if (!alias || projectArgs[3]) {
        console.error("Usage: latch project add --current <name>");
        process.exit(1);
      }

      try {
        const project = addCurrentProject(alias);
        console.log(`Saved project "${alias}" -> ${project.path}`);
      } catch (error: unknown) {
        exitWithError(error);
      }
      process.exit(0);
    }

    const inputPath = projectArgs[1];
    const alias = projectArgs[2];
    if (!inputPath || !alias || projectArgs[3]) {
      console.error("Usage: latch project add <path> <name>");
      process.exit(1);
    }

    try {
      const project = addProject(alias, inputPath);
      console.log(`Saved project "${alias}" -> ${project.path}`);
    } catch (error: unknown) {
      exitWithError(error);
    }
    process.exit(0);
  }

  if (subcommand === "open") {
    const alias = projectArgs[1];
    const popup = projectArgs.includes("--popup");
    const extraArgs = projectArgs.slice(2).filter((arg) => arg !== "--popup");
    if (!alias || extraArgs.length > 0) {
      console.error("Usage: latch project open <name>");
      process.exit(1);
    }
    openSavedProject(alias, { popup });
  }

  if (subcommand === "remove") {
    const alias = projectArgs[1];
    if (!alias || projectArgs[2]) {
      console.error("Usage: latch project remove <name>");
      process.exit(1);
    }

    try {
      removeProject(alias);
      console.log(`Removed project "${alias}".`);
    } catch (error: unknown) {
      exitWithError(error);
    }
    process.exit(0);
  }

  console.error(`Unknown project command "${subcommand}".`);
  process.exit(1);
}

if (args.includes("--help") || args.includes("-h")) {
  printHelp();
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

if (command === "project") {
  handleProjectCommand(args.slice(1));
}

if (command === "init") {
  const autoInstallTmux = !args.includes("--no-install-tmux");
  initHook({ autoInstallTmux });
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
  // Find the most recent transcript for this cwd (optional — chat.py lists all sessions)
  const projectDir = cwd.replace(/\//g, "-");
  const projectPath = join(homedir(), ".claude", "projects", projectDir);
  let sessionId = "";
  try {
    const files = readdirSync(projectPath)
      .filter((f: string) => f.endsWith(".jsonl"))
      .map((f: string) => ({ name: f, mtime: statSync(join(projectPath, f)).mtimeMs }))
      .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
    if (files.length > 0) {
      sessionId = files[0].name.replace(/\.jsonl$/, "");
    }
  } catch {}
  try {
    openChatPopup(cwd, sessionId);
  } catch (e: unknown) {
    console.error("latch chat: failed to open popup:", (e as Error).message);
    process.exit(1);
  }
  process.exit(0);
}

if (command === "projects") {
  const cwd = process.cwd();
  if (!isInsideTmux()) {
    console.error("latch projects: must be run inside a tmux session.");
    process.exit(1);
  }
  try {
    openProjectsPopup(cwd);
  } catch (e: unknown) {
    console.error("latch projects: failed to open popup:", (e as Error).message);
    process.exit(1);
  }
  process.exit(0);
}

if (command === "workspaces") {
  const cwd = process.cwd();
  if (!isInsideTmux()) {
    console.error("latch workspaces: must be run inside a tmux session.");
    process.exit(1);
  }
  try {
    focusOrOpenWorkspaces(cwd);
  } catch (e: unknown) {
    console.error("latch workspaces: failed to open pane:", (e as Error).message);
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

if (command) {
  try {
    const project = getProject(command);
    if (project) {
      openSavedProject(command);
    }
  } catch (error: unknown) {
    exitWithError(error);
  }

  console.error(`Unknown command or project "${command}".`);
  process.exit(1);
}

if (isInsideTmux()) {
  console.log("Latch: opening pane...");
  const paneId = splitAndLaunchSidecar(cwd);
  saveSidecarPaneId(cwd, "", paneId);
  console.log(`Latch: running in pane ${paneId}`);
} else {
  console.log("Latch: not inside tmux, creating new session...");
  launchNewSession(cwd);
}
