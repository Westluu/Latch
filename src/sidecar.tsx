#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import App from "./ui/App.js";
import { startIpcServer } from "./ipc.js";
import { installMouseTracking } from "./ui/useMouse.js";

const cwd = process.argv[2] || process.cwd();

type OpenHandler = (filePath: string) => void;
const handlers: OpenHandler[] = [];

export function onFileOpen(handler: OpenHandler) {
  handlers.push(handler);
}

function notifyHandlers(filePath: string) {
  for (const handler of handlers) {
    handler(filePath);
  }
}

startIpcServer((msg) => {
  if (msg.type === "open") {
    notifyHandlers(msg.filePath);
  }
});

// Ensure mouse tracking is always cleaned up on exit
import { cleanupMouseTracking } from "./ui/useMouse.js";
const cleanup = () => { cleanupMouseTracking(); };
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("uncaughtException", () => { cleanup(); process.exit(1); });

installMouseTracking();
render(React.createElement(App, { cwd, onFileOpen }));
