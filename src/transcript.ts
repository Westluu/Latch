// Shared transcript parsing logic for Latch hooks.
// Extracts turns, files, diffs, and labels from Claude Code session JSONL.

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import type { TurnFile } from "./ipc.js";

// ── Types ───────────────────────────────────────────────────────────────────

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

type ParsedLine = Record<string, unknown>;

export type ParsedTurn = {
  label: string;
  files: TurnFile[];
  diffStats: { added: number; removed: number };
};

export type ToolUseInfo = {
  name: string;
  file?: string;
};

export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
  tools?: ToolUseInfo[];
};

// ── Helpers ─────────────────────────────────────────────────────────────────

export function sessionIdFromTranscript(transcriptPath: string): string {
  return transcriptPath.replace(/\.jsonl$/, "").split("/").pop() ?? "";
}

export function planFileFromTranscript(transcriptPath: string): string | null {
  try {
    const lines = readFileSync(transcriptPath, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const slug = obj.slug as string | undefined;
        if (slug) return join(homedir(), ".claude", "plans", `${slug}.md`);
      } catch {}
    }
  } catch {}
  return null;
}

function backupPath(sessionId: string, backupFileName: string): string {
  return join(homedir(), ".claude", "file-history", sessionId, backupFileName);
}

function isRealUserMsg(obj: ParsedLine): boolean {
  if (obj.type !== "user" || obj.isSidechain !== false) return false;
  const msg = obj.message as Record<string, unknown> | undefined;
  const content = msg?.content;
  if (typeof content === "string") return true;
  if (Array.isArray(content)) {
    return content.some((b: Record<string, unknown>) => b?.type === "text");
  }
  return false;
}

function extractLabelFromEntry(obj: ParsedLine): string {
  const msg = obj.message as Record<string, unknown> | undefined;
  const content = msg?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? ((content.find((b: Record<string, unknown>) => b?.type === "text") as Record<string, unknown>)?.text as string ?? "")
        : "";
  const first = text.split("\n").find((l: string) => l.trim());
  return first ? first.trim().slice(0, 60) : "";
}

function extractFilesFromEntries(entries: ParsedLine[]): string[] {
  const files = new Set<string>();
  for (const obj of entries) {
    if (obj.type !== "assistant") continue;
    const msg = obj.message as Record<string, unknown> | undefined;
    const content = msg?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if ((block as Record<string, unknown>).type !== "tool_use") continue;
      const b = block as Record<string, unknown>;
      const name = b.name as string;
      const input = b.input as Record<string, unknown> | undefined;
      if (["Write", "Edit", "Create"].includes(name)) {
        const fp = input?.file_path as string | undefined;
        if (fp) files.add(fp);
      } else if (name === "MultiEdit") {
        for (const edit of (input?.edits as Record<string, unknown>[]) ?? []) {
          if (edit.file_path) files.add(edit.file_path as string);
        }
      }
    }
  }
  return [...files];
}

export function getDiffStats(files: TurnFile[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const file of files) {
    try {
      if (file.backupFile === null) {
        if (existsSync(file.path)) {
          added += readFileSync(file.path, "utf-8").split("\n").length;
        }
      } else if (existsSync(file.backupFile) && existsSync(file.path)) {
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

// ── Core: resolve files for a turn using snapshot data ──────────────────────

function resolveTurnFiles(
  cwd: string,
  sessionId: string,
  absPaths: string[],
  turnSnapshots: SnapshotEntry[],
): TurnFile[] {
  // Find turn-start snapshot (last isSnapshotUpdate: false)
  let lastFalseIdx = -1;
  for (let i = turnSnapshots.length - 1; i >= 0; i--) {
    if (!turnSnapshots[i].isSnapshotUpdate) { lastFalseIdx = i; break; }
  }

  const lastFalse = lastFalseIdx >= 0 ? turnSnapshots[lastFalseIdx] : null;

  // Collect first-seen backup for each file from isSnapshotUpdate:true entries
  const turnBeforeBackups: Record<string, BackupEntry> = {};
  for (let i = lastFalseIdx + 1; i < turnSnapshots.length; i++) {
    const snap = turnSnapshots[i];
    for (const [relPath, entry] of Object.entries(snap.snapshot.trackedFileBackups)) {
      if (!(relPath in turnBeforeBackups)) {
        turnBeforeBackups[relPath] = entry;
      }
    }
  }

  const prevFiles = lastFalse?.snapshot.trackedFileBackups ?? {};

  return absPaths.map((absPath) => {
    const relPath = relative(cwd, absPath);

    const turnEntry = turnBeforeBackups[relPath] ?? null;
    if (turnEntry && turnEntry.backupFileName !== null) {
      return { path: absPath, backupFile: backupPath(sessionId, turnEntry.backupFileName), isNew: false };
    }

    const entry = prevFiles[relPath] ?? null;
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

// ── Public API ──────────────────────────────────────────────────────────────

/** Parse the last turn from a transcript (used by stop-hook) */
export function parseLastTurn(cwd: string, transcriptPath: string, sessionId: string): ParsedTurn | null {
  const lines = readFileSync(transcriptPath, "utf-8").trim().split("\n");
  const parsed: ParsedLine[] = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line)); } catch {}
  }

  // Find the last real user message
  let lastUserIdx = -1;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (isRealUserMsg(parsed[i])) { lastUserIdx = i; break; }
  }
  if (lastUserIdx < 0) return null;

  const turnEntries = parsed.slice(lastUserIdx);
  const absPaths = extractFilesFromEntries(turnEntries);
  if (absPaths.length === 0) return null;

  const label = extractLabelFromEntry(parsed[lastUserIdx]);

  // Get snapshots from the full transcript for this turn
  const allSnapshots: SnapshotEntry[] = parsed.filter(
    (e) => e.type === "file-history-snapshot"
  ) as unknown as SnapshotEntry[];

  const files = resolveTurnFiles(cwd, sessionId, absPaths, allSnapshots);
  const diffStats = getDiffStats(files);

  return {
    label: label || `${files.length} file${files.length !== 1 ? "s" : ""} changed`,
    files,
    diffStats,
  };
}

/** Parse ALL turns from a transcript (used by session-start-hook for replay) */
export function parseAllTurns(cwd: string, transcriptPath: string, sessionId: string): ParsedTurn[] {
  const lines = readFileSync(transcriptPath, "utf-8").trim().split("\n");
  const parsed: ParsedLine[] = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line)); } catch {}
  }

  // Find all real user message indices (turn boundaries)
  const turnStarts: number[] = [];
  for (let i = 0; i < parsed.length; i++) {
    if (isRealUserMsg(parsed[i])) turnStarts.push(i);
  }

  if (turnStarts.length === 0) return [];

  // Collect all snapshots
  const allSnapshots: SnapshotEntry[] = parsed.filter(
    (e) => e.type === "file-history-snapshot"
  ) as unknown as SnapshotEntry[];

  const turns: ParsedTurn[] = [];

  for (let t = 0; t < turnStarts.length; t++) {
    const startIdx = turnStarts[t];
    const endIdx = t + 1 < turnStarts.length ? turnStarts[t + 1] : parsed.length;
    const turnEntries = parsed.slice(startIdx, endIdx);

    const absPaths = extractFilesFromEntries(turnEntries);
    if (absPaths.length === 0) continue;

    const label = extractLabelFromEntry(parsed[startIdx]);

    // Get snapshots that fall within this turn's range
    const turnSnapshots = turnEntries.filter(
      (e) => e.type === "file-history-snapshot"
    ) as unknown as SnapshotEntry[];

    const files = resolveTurnFiles(cwd, sessionId, absPaths, turnSnapshots);
    const diffStats = getDiffStats(files);

    turns.push({
      label: label || `${files.length} file${files.length !== 1 ? "s" : ""} changed`,
      files,
      diffStats,
    });
  }

  return turns;
}

/** Parse full conversation messages from a transcript */
export function parseConversation(transcriptPath: string): ConversationMessage[] {
  const lines = readFileSync(transcriptPath, "utf-8").trim().split("\n");
  const messages: ConversationMessage[] = [];

  for (const line of lines) {
    let obj: ParsedLine;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.type === "user" && isRealUserMsg(obj)) {
      const text = extractTextContent(obj);
      if (text) messages.push({ role: "user", content: text });
    } else if (obj.type === "assistant") {
      const msg = obj.message as Record<string, unknown> | undefined;
      const content = msg?.content;
      if (!Array.isArray(content)) continue;

      const textParts: string[] = [];
      const tools: ToolUseInfo[] = [];

      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          textParts.push(b.text);
        } else if (b.type === "tool_use") {
          const input = b.input as Record<string, unknown> | undefined;
          tools.push({
            name: b.name as string,
            file: (input?.file_path as string) ?? (input?.command as string) ?? undefined,
          });
        }
      }

      const text = textParts.join("\n").trim();
      if (text || tools.length > 0) {
        messages.push({ role: "assistant", content: text, tools: tools.length > 0 ? tools : undefined });
      }
    }
  }

  return messages;
}

function extractTextContent(obj: ParsedLine): string {
  const msg = obj.message as Record<string, unknown> | undefined;
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: Record<string, unknown>) => b?.type === "text")
      .map((b: Record<string, unknown>) => b.text as string)
      .join("\n")
      .trim();
  }
  return "";
}

/** Quick check: does this transcript contain any Write/Edit tool uses? */
export function hasEdits(transcriptPath: string): boolean {
  if (!existsSync(transcriptPath)) return false;
  const content = readFileSync(transcriptPath, "utf-8");
  return /"name"\s*:\s*"(Write|Edit|MultiEdit|Create)"/.test(content);
}
