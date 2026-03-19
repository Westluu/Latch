import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileEntry } from "./ui/FileList.js";

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8" }).trim();
}

const statusMap: Record<string, FileEntry["status"]> = {
  M: "modified",
  A: "added",
  D: "deleted",
  "?": "untracked",
  AM: "added",
  MM: "modified",
};

export function getChangedFiles(cwd: string): FileEntry[] {
  try {
    const output = run("git status --porcelain", cwd);
    if (!output) return [];

    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const xy = line.slice(0, 2).trim();
        const path = line.slice(3);
        const status = statusMap[xy] ?? "modified";
        return { path, status };
      });
  } catch {
    return [];
  }
}

export function readFile(cwd: string, filePath: string): string | null {
  try {
    const fullPath = join(cwd, filePath);
    return readFileSync(fullPath, "utf-8");
  } catch {
    return null;
  }
}

export function getDiff(cwd: string, filePath: string): string | null {
  try {
    // Try staged diff first, fall back to unstaged, then untracked
    let diff = run(`git diff --cached -- "${filePath}"`, cwd);
    if (!diff) {
      diff = run(`git diff -- "${filePath}"`, cwd);
    }
    if (!diff) {
      // Untracked file — show full contents as "added"
      const content = readFile(cwd, filePath);
      if (content) {
        return content
          .split("\n")
          .map((line) => `+ ${line}`)
          .join("\n");
      }
    }
    return diff || null;
  } catch {
    return null;
  }
}
