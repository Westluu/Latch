#!/usr/bin/env node
const fs = require("fs");
const net = require("net");

const SOCKET_PATH = "/tmp/latch.sock";
const LOG = "/tmp/latch-hook.log";

function log(msg) {
  try { fs.appendFileSync(LOG, new Date().toISOString() + " " + msg + "\n"); } catch(e) {}
}

log("hook started");

let input = "";
const t = setTimeout(() => { log("timeout"); process.exit(0); }, 5000);

process.stdin.setEncoding("utf8");
process.stdin.on("error", (e) => { log("stdin error: " + e.message); process.exit(0); });
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  clearTimeout(t);
  log("got input length=" + input.length);

  let data;
  try {
    data = JSON.parse(input);
  } catch(e) {
    log("parse error: " + e.message);
    process.exit(0);
  }

  const filePath = data.tool_input && data.tool_input.file_path;
  log("tool=" + data.tool_name + " file=" + filePath);

  if (!filePath) {
    log("no file_path, exit");
    process.exit(0);
  }

  const cwd = data.cwd || process.cwd();
  const relative = filePath.startsWith(cwd + "/") ? filePath.slice(cwd.length + 1) : filePath;
  log("relative=" + relative);

  if (!fs.existsSync(SOCKET_PATH)) {
    log("no socket");
    process.exit(0);
  }

  const socket = net.connect(SOCKET_PATH);
  socket.on("connect", () => {
    log("connected");
    socket.write(JSON.stringify({ type: "open", filePath: relative }) + "\n");
  });
  socket.on("data", () => { log("got response"); socket.end(); });
  socket.on("end", () => { log("done"); process.exit(0); });
  socket.on("error", (e) => { log("socket err: " + e.message); process.exit(0); });
});

process.on("uncaughtException", (e) => { log("uncaught: " + e.message); process.exit(0); });
