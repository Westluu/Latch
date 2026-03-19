#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import App from "./ui/App.js";
import { startIpcServer } from "./ipc.js";

const cwd = process.argv[2] || process.cwd();

// Handlers that the App component will register to receive file open events
type OpenHandler = (filePath: string) => void;
const handlers: OpenHandler[] = [];

export function onFileOpen(handler: OpenHandler) {
  handlers.push(handler);
}

startIpcServer((msg) => {
  if (msg.type === "open") {
    for (const handler of handlers) {
      handler(msg.filePath);
    }
  }
});

render(React.createElement(App, { cwd, onFileOpen }));
