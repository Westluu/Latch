import { homedir } from "node:os";
import { join } from "node:path";

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
