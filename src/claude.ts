import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, realpathSync } from "node:fs";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, "-");
}

function legacyClaudeProjectDirName(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

export function claudeProjectPaths(cwd: string): string[] {
  const names = [claudeProjectDirName(cwd), legacyClaudeProjectDirName(cwd)];
  return [...new Set(names)].map((name) => join(CLAUDE_PROJECTS_DIR, name));
}

function normalizeCwd(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function transcriptMatchesCwd(transcriptPath: string, cwd: string): boolean {
  try {
    const lines = readFileSync(transcriptPath, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.includes('"cwd"')) continue;
      const match = line.match(/"cwd"\s*:\s*"([^"]+)"/);
      if (match) {
        return normalizeCwd(match[1]) === normalizeCwd(cwd);
      }
    }
  } catch {
    return false;
  }
  return true;
}
