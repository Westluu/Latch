#!/usr/bin/env node
const fs = require("fs");
const net = require("net");
const { execSync } = require("child_process");
const path = require("path");

const SOCKET_PATH = "/tmp/latch.sock";
const LOG = "/tmp/latch-hook.log";

function log(msg) {
  try { fs.appendFileSync(LOG, new Date().toISOString() + " " + msg + "\n"); } catch(e) {}
}

function sendToSocket(filePath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(SOCKET_PATH);
    socket.on("connect", () => {
      log("connected");
      socket.write(JSON.stringify({ type: "open", filePath }) + "\n");
    });
    socket.on("data", () => { log("got response"); socket.end(); });
    socket.on("end", () => { log("done"); resolve(); });
    socket.on("error", (e) => { log("socket err: " + e.message); reject(e); });
  });
}

function launchSidecar(cwd) {
  try {
    const sidecarScript = path.join(__dirname, "sidecar.tsx");
    // Check if we're in tmux
    if (!process.env.TMUX) {
      log("not in tmux, cannot launch sidecar");
      return false;
    }
    log("launching sidecar...");
    execSync(
      `tmux split-window -h -l 40% -c '${cwd}' 'npx tsx "${sidecarScript}" "${cwd}"'`,
      { encoding: "utf-8" }
    );
    return true;
  } catch(e) {
    log("launch error: " + e.message);
    return false;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

log("hook started");

let input = "";
const t = setTimeout(() => { log("timeout"); process.exit(0); }, 15000);

process.stdin.setEncoding("utf8");
process.stdin.on("error", (e) => { log("stdin error: " + e.message); process.exit(0); });
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
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

  // Try connecting to existing sidecar
  if (fs.existsSync(SOCKET_PATH)) {
    try {
      await sendToSocket(relative);
      process.exit(0);
    } catch(e) {
      log("existing socket failed, will try launching");
    }
  }

  // Sidecar not running — launch it
  if (!launchSidecar(cwd)) {
    process.exit(0);
  }

  // Wait for socket to appear (up to 8 seconds)
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    if (fs.existsSync(SOCKET_PATH)) {
      try {
        await sendToSocket(relative);
        process.exit(0);
      } catch(e) {
        log("retry " + i + " failed");
      }
    }
  }

  log("timed out waiting for sidecar");
  process.exit(0);
});

process.on("uncaughtException", (e) => { log("uncaught: " + e.message); process.exit(0); });
