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

export type IpcMessage = {
  type: "open";
  filePath: string;
};

type MessageHandler = (msg: IpcMessage) => void;

export function startIpcServer(cwd: string, onMessage: MessageHandler): Server {
  const socketPath = getSocketPath(cwd);

  // Clean up stale socket
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }

  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as IpcMessage;
          onMessage(msg);
          socket.write("ok\n");
        } catch {
          socket.write("error: invalid json\n");
        }
      }
    });
  });

  server.listen(socketPath);

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

export function sendIpcMessage(cwd: string, msg: IpcMessage): Promise<string> {
  const socketPath = getSocketPath(cwd);
  return new Promise((resolve, reject) => {
    if (!existsSync(socketPath)) {
      reject(new Error("Latch sidecar is not running. Start it with: latch"));
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

    socket.on("end", () => {
      resolve(response.trim());
    });

    socket.on("error", (err) => {
      reject(new Error(`Cannot connect to Latch sidecar: ${err.message}`));
    });
  });
}
