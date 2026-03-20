#!/usr/bin/env node
// Claude Code Stop hook for Latch
// Fires when Claude's turn ends. Reads the session JSONL to diff consecutive
// turn-boundary snapshots, then sends the turn to the tray via IPC.

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve, dirname, relative } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { getTraySocketPath, sendTrayMessage, type TurnFile } from "./ipc.js";
import { getSidecarPaneId } from "./tmux.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── JSONL snapshot types ─────────────────────────────────────────────────────

type BackupEntry = {
  backupFileName: string | null;
  version: number;
  backupTime: string;
};

type SnapshotEntry = {
  type: "file-history-snapshot";
  messageId: string;
  isSnapshotUpdate: boolean;
  snapshot: {
    trackedFileBackups: Record<string, BackupEntry>;
  };
};

// ── helpers ──────────────────────────────────────────────────────────────────

function trayCommand(cwd: string): string {
  const distTray = resolve(__dirname, "tray.js");
  if (existsSync(distTray)) return `node "${distTray}" "${cwd}"`;
  const rootDistTray = resolve(__dirname, "..", "dist", "tray.js");
  if (existsSync(rootDistTray)) return `node "${rootDistTray}" "${cwd}"`;
  const tsxBin = resolve(__dirname, "..", "node_modules", ".bin", "tsx");
  const traySrc = resolve(__dirname, "tray.tsx");
  return `"${tsxBin}" "${traySrc}" "${cwd}"`;
}

// Parse the session JSONL and return only file-history-snapshot entries
function parseSnapshots(transcriptPath: string): SnapshotEntry[] {
  const lines = readFileSync(transcriptPath, "utf-8").trim().split("\n");
  const snapshots: SnapshotEntry[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "file-history-snapshot") snapshots.push(obj as SnapshotEntry);
    } catch {}
  }
  return snapshots;
}

// Get the session ID from the transcript path (the JSONL filename without extension)
function sessionIdFromTranscript(transcriptPath: string): string {
  return transcriptPath.replace(/\.jsonl$/, "").split("/").pop() ?? "";
}

// Resolve a backupFileName to its full path on disk
function backupPath(sessionId: string, backupFileName: string): string {
  return join(homedir(), ".claude", "file-history", sessionId, backupFileName);
}

// Diff the last false (prev turn state) vs last true (current turn state)
// to find what changed in the current turn.
//
// NOTE: isSnapshotUpdate=false is written when the NEXT user message arrives,
// not when the turn ends. So at Stop hook time, only true entries exist for
// the current turn. We use lastTrue vs lastFalse to detect this turn's changes.
function getTurnFiles(snapshots: SnapshotEntry[], sessionId: string): TurnFile[] {
  const lastFalse = snapshots.filter((s) => !s.isSnapshotUpdate).at(-1);
  const lastTrue  = snapshots.filter((s) =>  s.isSnapshotUpdate).at(-1);

  if (!lastTrue) return []; // no file edits this turn

  const prevFiles = lastFalse?.snapshot.trackedFileBackups ?? {};
  const currFiles = lastTrue.snapshot.trackedFileBackups;

  const changed: TurnFile[] = [];

  for (const [filePath, curr] of Object.entries(currFiles)) {
    const prev = prevFiles[filePath];

    // Skip files not changed in this turn (version unchanged vs prev false boundary)
    if (prev && curr.version === prev.version) continue;

    // curr.backupFileName = backup created BEFORE this turn's first edit to this file
    // null means the file was created this turn (no before-state) → revert = delete
    changed.push({
      path: filePath,
      backupFile: curr.backupFileName ? backupPath(sessionId, curr.backupFileName) : null,
      isNew: curr.backupFileName === null,
    });
  }

  return changed;
}

function getDiffStats(
  cwd: string,
  files: TurnFile[]
): { added: number; removed: number } {
  try {
    const paths = files.map((f) => relative(cwd, f.path)).filter(Boolean);
    if (paths.length === 0) return { added: 0, removed: 0 };
    const out = execSync(
      `git diff --numstat HEAD -- ${paths.map((p) => JSON.stringify(p)).join(" ")}`,
      { cwd, encoding: "utf-8" }
    );
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

function extractLabel(transcriptPath: string): string {
  try {
    const lines = readFileSync(transcriptPath, "utf-8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const obj = JSON.parse(lines[i]);
      if (obj.type !== "assistant") continue;
      const content = obj.message?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
          ? (content.find((b: Record<string, unknown>) => b?.type === "text") as Record<string, unknown>)?.text as string ?? ""
          : "";
      const first = text.split("\n").find((l: string) => l.trim());
      if (first) return first.trim().slice(0, 60);
    }
  } catch {}
  return "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── main ─────────────────────────────────────────────────────────────────────

let input = "";
const timeout = setTimeout(() => process.exit(0), 10000);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", async () => {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input) as Record<string, unknown>;
    const cwd = (data.cwd as string) || process.cwd();
    const transcriptPath = data.transcript_path as string | undefined;

    if (!transcriptPath || !existsSync(transcriptPath)) process.exit(0);

    const sessionId = sessionIdFromTranscript(transcriptPath);
    const snapshots = parseSnapshots(transcriptPath);
    const files = getTurnFiles(snapshots, sessionId);

    if (files.length === 0) process.exit(0);

    const label = extractLabel(transcriptPath) || `${files.length} file${files.length !== 1 ? "s" : ""} changed`;
    const diffStats = getDiffStats(cwd, files);

    const traySocket = getTraySocketPath(cwd);
    const trayRunning = existsSync(traySocket);

    if (!trayRunning && process.env.TMUX) {
      const sidecarPane = getSidecarPaneId(cwd);
      // If sidecar is open, split above it (-b) so tray sits on top of the file viewer
      const targetFlag = sidecarPane ? `-b -t ${sidecarPane}` : "";
      execSync(
        `tmux split-window -v -l 10 ${targetFlag} -c ${JSON.stringify(cwd)} '${trayCommand(cwd)}'`
      );
      for (let i = 0; i < 8; i++) {
        await sleep(500);
        if (existsSync(traySocket)) break;
      }
    }

    await sendTrayMessage(cwd, { type: "turn", label, files, diffStats });
  } catch {
    // Silently fail — don't break Claude Code
  }
  process.exit(0);
});
