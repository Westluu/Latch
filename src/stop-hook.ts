#!/usr/bin/env node
// Claude Code Stop hook for Latch
// Fires when Claude's turn ends. Sends turn data to the tray via IPC,
// launching the tray pane first if it isn't already running.

import { readFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getTraySocketPath, sendTrayMessage } from "./ipc.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getPendingFilePath(cwd: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  const dir = join(tmpdir(), "latch");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}-pending.txt`);
}

function trayCommand(cwd: string): string {
  const distTray = resolve(__dirname, "tray.js");
  if (existsSync(distTray)) return `node "${distTray}" "${cwd}"`;
  const rootDistTray = resolve(__dirname, "..", "dist", "tray.js");
  if (existsSync(rootDistTray)) return `node "${rootDistTray}" "${cwd}"`;
  const tsxBin = resolve(__dirname, "..", "node_modules", ".bin", "tsx");
  const traySrc = resolve(__dirname, "tray.tsx");
  return `"${tsxBin}" "${traySrc}" "${cwd}"`;
}

function getDiffStats(cwd: string): { added: number; removed: number } {
  try {
    const out = execSync("git diff --numstat HEAD", { cwd, encoding: "utf-8" });
    let added = 0, removed = 0;
    for (const line of out.trim().split("\n")) {
      const [a, r] = line.split("\t");
      added += parseInt(a) || 0;
      removed += parseInt(r) || 0;
    }
    return { added, removed };
  } catch {
    return { added: 0, removed: 0 };
  }
}

function extractSummary(data: Record<string, unknown>): string {
  const transcript = data.transcript as Array<{ role: string; content: unknown }> | undefined;
  if (!Array.isArray(transcript)) return "";
  for (let i = transcript.length - 1; i >= 0; i--) {
    const msg = transcript[i];
    if (msg?.role !== "assistant") continue;
    const content = msg.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
        ? (content.find((b: Record<string, unknown>) => b?.type === "text") as Record<string, unknown>)?.text as string ?? ""
        : "";
    const first = text.split("\n").find((l) => l.trim());
    if (first) return first.trim().slice(0, 60);
  }
  return "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let input = "";
const timeout = setTimeout(() => process.exit(0), 10000);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", async () => {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input) as Record<string, unknown>;
    const cwd = (data.cwd as string) || process.cwd();
    const pendingPath = getPendingFilePath(cwd);

    if (!existsSync(pendingPath)) process.exit(0);

    const raw = readFileSync(pendingPath, "utf-8").trim();
    unlinkSync(pendingPath);

    const files = [...new Set(raw.split("\n").filter(Boolean))];
    if (files.length === 0) process.exit(0);

    const diffStats = getDiffStats(cwd);
    const summary = extractSummary(data) || `${files.length} file${files.length !== 1 ? "s" : ""} changed`;

    const traySocket = getTraySocketPath(cwd);
    const trayRunning = existsSync(traySocket);

    // Launch tray pane if not running (requires tmux)
    if (!trayRunning && process.env.TMUX) {
      execSync(
        `tmux split-window -v -l 10 -c ${JSON.stringify(cwd)} '${trayCommand(cwd)}'`
      );
      // Wait for the IPC socket to appear (up to 4s)
      for (let i = 0; i < 8; i++) {
        await sleep(500);
        if (existsSync(traySocket)) break;
      }
    }

    await sendTrayMessage(cwd, { type: "turn", label: summary, files, diffStats });
  } catch {
    // Silently fail — don't break Claude Code
  }
  process.exit(0);
});
