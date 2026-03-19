import { createServer, connect, type Server } from "node:net";
import { existsSync, unlinkSync, appendFileSync } from "node:fs";

const LOG_PATH = "/tmp/latch.log";

const SOCKET_PATH = "/tmp/latch.sock";

export type IpcMessage = {
  type: "open";
  filePath: string;
};

type MessageHandler = (msg: IpcMessage) => void;

export function startIpcServer(onMessage: MessageHandler): Server {
  // Clean up stale socket
  if (existsSync(SOCKET_PATH)) {
    unlinkSync(SOCKET_PATH);
  }

  const log = (msg: string) => {
    const line = `[latch-ipc] ${new Date().toISOString()} ${msg}\n`;
    appendFileSync(LOG_PATH, line);
  };

  const server = createServer((socket) => {
    log("client connected");
    let buffer = "";
    socket.on("data", (data) => {
      const raw = data.toString();
      log(`raw data received: ${JSON.stringify(raw)}`);
      buffer += raw;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      log(`parsed ${lines.length} lines, buffer remaining: ${JSON.stringify(buffer)}`);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as IpcMessage;
          log(`parsed message: ${msg.type} → ${msg.filePath}`);
          onMessage(msg);
          socket.write("ok\n");
          log("sent ok response");
        } catch (e) {
          log(`parse error: ${e}`);
          socket.write("error: invalid json\n");
        }
      }
    });
    socket.on("end", () => log("client disconnected"));
    socket.on("error", (err) => log(`socket error: ${err.message}`));
  });

  server.listen(SOCKET_PATH, () => {
    log(`server listening on ${SOCKET_PATH}`);
  });

  const cleanup = () => {
    try {
      server.close();
      if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
    } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  return server;
}

export function sendIpcMessage(msg: IpcMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!existsSync(SOCKET_PATH)) {
      reject(new Error("Latch sidecar is not running. Start it with: latch"));
      return;
    }

    const socket = connect(SOCKET_PATH);
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
