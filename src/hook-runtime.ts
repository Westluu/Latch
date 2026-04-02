import { appendFileSync } from "node:fs";

export type DebugLogger = (...args: unknown[]) => void;

export function createFileLogger(logPath: string): DebugLogger {
  return (...args: unknown[]) => {
    try {
      appendFileSync(logPath, `[${new Date().toISOString()}] ${args.join(" ")}\n`);
    } catch {}
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readJsonFromStdin(timeoutMs: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let input = "";
    const timeout = setTimeout(() => resolve(null), timeoutMs);

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(input);
        resolve(isRecord(parsed) ? parsed : null);
      } catch {
        resolve(null);
      }
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
