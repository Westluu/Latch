#!/usr/bin/env node
// Claude Code Stop hook for Latch
// Fires when Claude's turn ends. Reads the session JSONL to diff consecutive
// turn-boundary snapshots, then sends the turn to the tray via IPC.

import { readFileSync, existsSync, appendFileSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { execSync } from "node:child_process";
import { join, resolve, dirname, relative } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { getTraySocketPath, sendTrayMessage, type TurnFile } from "./ipc.js";
import { getSidecarPaneId, saveTrayPaneId } from "./tmux.js";

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

const LOG = "/tmp/latch-debug.log";
const dbg = (...args: unknown[]) => {
  try { appendFileSync(LOG, `[${new Date().toISOString()}] ${args.join(" ")}\n`); } catch {}
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((res) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => { socket.destroy(); res(false); }, 1000);
    socket.on("connect", () => { clearTimeout(timer); socket.destroy(); res(true); });
    socket.on("error", () => { clearTimeout(timer); res(false); });
  });
}

function trayCommand(cwd: string, sessionId: string): string {
  const trayPy = resolve(__dirname, "..", "python", "tray.py");
  return `python3 "${trayPy}" "${cwd}" "${sessionId}"`;
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

// Extract file paths from tool_use blocks in the current turn.
// A "turn" = all assistant messages after the last main user message.
// Handles Write, Edit (single file), and MultiEdit (multiple files per call).
function getFilesFromToolUse(transcriptPath: string): string[] {
  const lines = readFileSync(transcriptPath, "utf-8").trim().split("\n");

  // Find the last main user message (isSidechain: false, string or array content)
  let lastUserIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      const content = obj.message?.content;
      const isRealUserMsg =
        typeof content === "string" ||
        (Array.isArray(content) && content.some((b: Record<string, unknown>) => b?.type === "text"));
      if (obj.type === "user" && obj.isSidechain === false && isRealUserMsg) {
        lastUserIdx = i;
        break;
      }
    } catch {}
  }

  // Collect file paths from all assistant tool_use blocks after that message
  const files = new Set<string>();
  for (let i = lastUserIdx + 1; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.type !== "assistant") continue;
      const content = obj.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type !== "tool_use") continue;
        if (["Write", "Edit", "Create"].includes(block.name)) {
          const fp = block.input?.file_path;
          if (fp) files.add(fp);
        } else if (block.name === "MultiEdit") {
          for (const edit of block.input?.edits ?? []) {
            if (edit.file_path) files.add(edit.file_path);
          }
        }
      }
    } catch {}
  }

  return [...files];
}

// Build TurnFile list using Claude Code's own snapshot data.
// Strategy: the first isSnapshotUpdate:true entry after the turn-start snapshot
// (lastFalse) holds the backup created just before each file was first edited
// this turn — that IS the accurate before-state for this turn's diff.
function getTurnFiles(cwd: string, transcriptPath: string, sessionId: string): TurnFile[] {
  const absPaths = getFilesFromToolUse(transcriptPath);
  dbg("tool_use files:", absPaths.length, absPaths.join("|"));
  if (absPaths.length === 0) return [];

  const snapshots = parseSnapshots(transcriptPath);
  dbg("snapshots:", snapshots.length);

  // Find index of the last turn-start snapshot
  let lastFalseIdx = -1;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (!snapshots[i].isSnapshotUpdate) { lastFalseIdx = i; break; }
  }

  const lastFalse = lastFalseIdx >= 0 ? snapshots[lastFalseIdx] : null;
  dbg("lastFalse:", lastFalse ? JSON.stringify(Object.keys(lastFalse.snapshot.trackedFileBackups)) : "null");

  // Collect first-seen backup for each file from isSnapshotUpdate:true entries
  // that occur AFTER the turn-start snapshot. These backups were created just
  // before Claude's first edit of each file this turn.
  const turnBeforeBackups: Record<string, BackupEntry> = {};
  for (let i = lastFalseIdx + 1; i < snapshots.length; i++) {
    const snap = snapshots[i];
    for (const [relPath, entry] of Object.entries(snap.snapshot.trackedFileBackups)) {
      if (!(relPath in turnBeforeBackups)) {
        turnBeforeBackups[relPath] = entry;
      }
    }
  }
  dbg("turnBeforeBackups:", JSON.stringify(Object.keys(turnBeforeBackups)));

  const prevFiles = lastFalse?.snapshot.trackedFileBackups ?? {};

  return absPaths.map((absPath) => {
    const relPath = relative(cwd, absPath);

    // Prefer the turn-level backup (before-state for this specific turn)
    const turnEntry = turnBeforeBackups[relPath] ?? null;
    if (turnEntry && turnEntry.backupFileName !== null) {
      dbg("file:", absPath, "using turn-level backup:", turnEntry.backupFileName);
      return { path: absPath, backupFile: backupPath(sessionId, turnEntry.backupFileName), isNew: false };
    }

    // Fallback: session-level backup (before-state = before first edit in session)
    const entry = prevFiles[relPath] ?? null;
    dbg("file:", absPath, "relPath:", relPath, "entry:", entry ? entry.backupFileName : "null");

    if (!entry || entry.backupFileName === null) {
      return { path: absPath, backupFile: null, isNew: !existsSync(absPath) };
    }

    return {
      path: absPath,
      backupFile: backupPath(sessionId, entry.backupFileName),
      isNew: false,
    };
  });
}

function getDiffStats(files: TurnFile[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const file of files) {
    try {
      if (file.backupFile === null) {
        // New file — every line is an addition
        if (existsSync(file.path)) {
          added += readFileSync(file.path, "utf-8").split("\n").length;
        }
      } else if (existsSync(file.backupFile) && existsSync(file.path)) {
        // Compare backup (before) → current (after) with git diff --no-index
        // git exits 1 when there are differences, so we can't use execSync directly
        try {
          execSync(
            `git diff --no-index --numstat ${JSON.stringify(file.backupFile)} ${JSON.stringify(file.path)}`,
            { encoding: "utf-8" }
          );
        } catch (e: unknown) {
          const out = (e as { stdout?: string }).stdout ?? "";
          for (const line of out.trim().split("\n")) {
            const [a, r] = line.split("\t");
            added += parseInt(a) || 0;
            removed += parseInt(r) || 0;
          }
        }
      }
    } catch {}
  }
  return { added, removed };
}

function extractLabel(transcriptPath: string): string {
  try {
    const lines = readFileSync(transcriptPath, "utf-8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const obj = JSON.parse(lines[i]);
      const content = obj.message?.content;
      const isRealUserMsg =
        typeof content === "string" ||
        (Array.isArray(content) && content.some((b: Record<string, unknown>) => b?.type === "text"));
      if (obj.type === "user" && obj.isSidechain === false && isRealUserMsg) {
        const text =
          typeof content === "string"
            ? content
            : (content.find((b: Record<string, unknown>) => b?.type === "text") as Record<string, unknown>)?.text as string ?? "";
        const first = text.split("\n").find((l: string) => l.trim());
        if (first) return first.trim().slice(0, 60);
        break;
      }
    }
  } catch {}
  return "";
}

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
    dbg("fired cwd=" + cwd + " transcript=" + transcriptPath);

    if (!transcriptPath || !existsSync(transcriptPath)) {
      dbg("EXIT: no transcript");
      process.exit(0);
    }

    const sessionId = sessionIdFromTranscript(transcriptPath);
    const files = getTurnFiles(cwd, transcriptPath, sessionId);
    dbg("files=" + files.length + " " + files.map((f) => f.path).join("|"));

    if (files.length === 0) {
      dbg("EXIT: no files");
      process.exit(0);
    }

    const label = extractLabel(transcriptPath) || `${files.length} file${files.length !== 1 ? "s" : ""} changed`;
    const diffStats = getDiffStats(files);
    dbg("label=" + label + " stats=+" + diffStats.added + "/-" + diffStats.removed);

    const traySocket = getTraySocketPath(cwd, sessionId);
    let trayAlive = false;
    if (existsSync(traySocket)) {
      trayAlive = await isSocketAlive(traySocket);
      dbg("traySocket exists, alive=" + trayAlive);
      if (!trayAlive) {
        try { unlinkSync(traySocket); } catch {}
      }
    }
    dbg("trayAlive=" + trayAlive + " TMUX=" + !!process.env.TMUX);

    if (!trayAlive && process.env.TMUX) {
      // Verify sidecar pane still exists before targeting it (it may have been closed)
      const savedPane = getSidecarPaneId(cwd);
      let sidecarPane: string | null = null;
      if (savedPane) {
        try {
          execSync(`tmux list-panes -a -F '#{pane_id}' | grep -qF '${savedPane}'`);
          sidecarPane = savedPane;
        } catch {
          sidecarPane = null; // pane no longer exists
        }
      }
      const targetFlag = sidecarPane ? `-b -t ${sidecarPane}` : "";
      const cmd = `tmux split-window -v -l 10 -P -F '#{pane_id}' ${targetFlag} -c ${JSON.stringify(cwd)} '${trayCommand(cwd, sessionId)}'`;
      dbg("launching tray:", cmd);
      try {
        const trayPaneId = execSync(cmd, { encoding: "utf-8" }).trim();
        dbg("tray pane:", trayPaneId);
        saveTrayPaneId(cwd, trayPaneId);
      } catch (e) {
        dbg("tmux launch failed:", e);
      }
      for (let i = 0; i < 8; i++) {
        await sleep(500);
        if (existsSync(traySocket)) break;
      }
      dbg("socket after wait:", existsSync(traySocket));
    }

    await sendTrayMessage(cwd, sessionId, { type: "turn", label, files, diffStats });
    dbg("message sent");
  } catch (e) {
    dbg("CAUGHT ERROR:", e);
  }
  process.exit(0);
});
