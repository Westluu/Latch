import { connect } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function getSocketDir(): string {
  const dir = process.env.XDG_RUNTIME_DIR
    ? join(process.env.XDG_RUNTIME_DIR, "latch")
    : join(tmpdir(), "latch");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getSidecarSocketPath(cwd: string, sessionId: string = ""): string {
  const hash = createHash("sha256").update(cwd + sessionId).digest("hex").slice(0, 12);
  return join(getSocketDir(), `${hash}-sidecar.sock`);
}

export function getTraySocketPath(cwd: string, sessionId: string): string {
  const hash = createHash("sha256").update(cwd + sessionId).digest("hex").slice(0, 12);
  return join(getSocketDir(), `${hash}-tray.sock`);
}

export type IpcMessage =
  | { type: "open"; filePath: string }
  | { type: "plan"; planFilePath: string };

export type TurnFile = {
  path: string;
  backupFile: string | null;
  isNew: boolean;
};

export type TrayMessage = {
  type: "turn";
  label: string;
  files: TurnFile[];
  diffStats: { added: number; removed: number };
};

// ── send helpers ────────────────────────────────────────────────────────────

function sendToSocket<T>(socketPath: string, msg: T): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!existsSync(socketPath)) {
      reject(new Error("Latch is not running on this socket."));
      return;
    }

    const socket = connect(socketPath);
    let response = "";

    socket.on("connect", () => {
      socket.write(JSON.stringify(msg) + "\n");
    });

    socket.on("data", (data) => {
      response += data.toString();
      socket.end();
    });

    socket.on("end", () => resolve(response.trim()));
    socket.on("error", (err) => reject(new Error(`Cannot connect: ${err.message}`)));
  });
}

export function sendSidecarMessage(cwd: string, sessionId: string, msg: IpcMessage): Promise<string> {
  return sendToSocket(getSidecarSocketPath(cwd, sessionId), msg);
}

export function sendTrayMessage(cwd: string, sessionId: string, msg: TrayMessage): Promise<string> {
  return sendToSocket(getTraySocketPath(cwd, sessionId), msg);
}
