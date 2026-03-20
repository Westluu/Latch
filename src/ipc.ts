import { createServer, connect, type Server } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function getSocketDir(): string {
  const dir = process.env.XDG_RUNTIME_DIR
    ? join(process.env.XDG_RUNTIME_DIR, "latch")
    : join(tmpdir(), "latch");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getSocketPath(cwd: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  return join(getSocketDir(), `${hash}.sock`);
}

export function getTraySocketPath(cwd: string, sessionId: string): string {
  const hash = createHash("sha256").update(cwd + sessionId).digest("hex").slice(0, 12);
  return join(getSocketDir(), `${hash}-tray.sock`);
}

export type IpcMessage = {
  type: "open";
  filePath: string;
};

export type TurnFile = {
  path: string;
  backupFile: string | null; // full path to ~/.claude/file-history backup; null = file was created (revert = delete)
  isNew: boolean;
};

export type TrayMessage = {
  type: "turn";
  label: string;
  files: TurnFile[];
  diffStats: { added: number; removed: number };
};

// ── shared internals ────────────────────────────────────────────────────────

function startServerOnSocket<T>(
  socketPath: string,
  onMessage: (msg: T) => void
): Server {
  if (existsSync(socketPath)) unlinkSync(socketPath);

  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as T;
          onMessage(msg);
          socket.write("ok\n");
        } catch {
          socket.write("error: invalid json\n");
        }
      }
    });
  });

  server.listen(socketPath, () => {
    console.error(`[latch] IPC server listening on ${socketPath}`);
  });

  server.on("error", (err) => {
    console.error(`[latch] IPC server error: ${err.message}`);
    process.exit(1);
  });

  const cleanup = () => {
    try {
      server.close();
      if (existsSync(socketPath)) unlinkSync(socketPath);
    } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  return server;
}

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

// ── sidecar IPC ─────────────────────────────────────────────────────────────

export function startIpcServer(cwd: string, onMessage: (msg: IpcMessage) => void): Server {
  return startServerOnSocket(getSocketPath(cwd), onMessage);
}

export function sendIpcMessage(cwd: string, msg: IpcMessage): Promise<string> {
  return sendToSocket(getSocketPath(cwd), msg);
}

// ── tray IPC ─────────────────────────────────────────────────────────────────

export function startTrayIpcServer(cwd: string, sessionId: string, onMessage: (msg: TrayMessage) => void): Server {
  return startServerOnSocket(getTraySocketPath(cwd, sessionId), onMessage);
}

export function sendTrayMessage(cwd: string, sessionId: string, msg: TrayMessage): Promise<string> {
  return sendToSocket(getTraySocketPath(cwd, sessionId), msg);
}
