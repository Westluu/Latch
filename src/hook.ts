#!/usr/bin/env node
// Claude Code PostToolUse hook for Latch
// Receives tool use data via stdin, sends file path to sidecar via IPC

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sendIpcMessage, getSocketPath } from "./ipc.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isMdOrPlan(filePath: string): boolean {
  return filePath.endsWith(".md") || /plan/i.test(filePath);
}

function sidecarCommand(cwd: string): string {
  const distSidecar = resolve(__dirname, "sidecar.js");
  if (existsSync(distSidecar)) return `node "${distSidecar}" "${cwd}"`;
  const rootDistSidecar = resolve(__dirname, "..", "dist", "sidecar.js");
  if (existsSync(rootDistSidecar)) return `node "${rootDistSidecar}" "${cwd}"`;
  const tsxBin = resolve(__dirname, "..", "node_modules", ".bin", "tsx");
  const sidecarSrc = resolve(__dirname, "sidecar.tsx");
  return `"${tsxBin}" "${sidecarSrc}" "${cwd}"`;
}


function getSidecarPanePath(cwd: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  const dir = join(tmpdir(), "latch");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}-sidecar-pane.txt`);
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

    // Auto-launch sidecar if it's not running and this is a .md or plan file
    if (isMdOrPlan(relative) && process.env.TMUX) {
      const sidecarSocket = getSocketPath(cwd);
      if (!existsSync(sidecarSocket)) {
        // Save current pane ID before splitting
        const currentPane = execSync("tmux display-message -p '#{pane_id}'", {
          encoding: "utf-8",
        }).trim();
        execSync(
          `tmux split-window -h -f -c ${JSON.stringify(cwd)} '${sidecarCommand(cwd)}'`
        );
        // Capture sidecar pane ID so stop-hook can split above it for the tray
        const sidecarPane = execSync("tmux display-message -p '#{pane_id}'", {
          encoding: "utf-8",
        }).trim();
        writeFileSync(getSidecarPanePath(cwd), sidecarPane);
        // Switch focus back to original pane so other splits go to Claude
        execSync(`tmux select-pane -t ${currentPane}`);
        for (let i = 0; i < 8; i++) {
          await sleep(500);
          if (existsSync(sidecarSocket)) break;
        }
      }
    }

    await sendIpcMessage(cwd, { type: "open", filePath: relative });
  } catch {
    // Silently fail — don't break Claude Code
  }
  process.exit(0);
});
