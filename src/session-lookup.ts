import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeProjectPaths, transcriptMatchesCwd } from "./claude.js";

export type SessionTranscript = {
  path: string;
  sessionId: string;
  mtime: number;
};

export function listSessionTranscripts(cwd: string): SessionTranscript[] {
  const transcripts = new Map<string, SessionTranscript>();

  for (const projectPath of claudeProjectPaths(cwd)) {
    try {
      const files = readdirSync(projectPath).filter((name) => name.endsWith(".jsonl"));
      for (const name of files) {
        const transcriptPath = join(projectPath, name);
        if (!transcriptMatchesCwd(transcriptPath, cwd)) {
          continue;
        }

        const candidate = {
          path: transcriptPath,
          sessionId: name.replace(/\.jsonl$/, ""),
          mtime: statSync(transcriptPath).mtimeMs,
        };
        const existing = transcripts.get(candidate.sessionId);
        if (!existing || candidate.mtime > existing.mtime) {
          transcripts.set(candidate.sessionId, candidate);
        }
      }
    } catch {}
  }

  return [...transcripts.values()].sort((a, b) => b.mtime - a.mtime);
}

export function findLatestSessionId(cwd: string): string {
  return listSessionTranscripts(cwd)[0]?.sessionId ?? "";
}
