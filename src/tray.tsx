#!/usr/bin/env node
import React, { useState } from "react";
import { render } from "ink";
import TurnTray, { type TurnData } from "./ui/TurnTray.js";
import { startTrayIpcServer } from "./ipc.js";

const cwd = process.argv[2] || process.cwd();

let addTurn: ((turn: TurnData) => void) | null = null;

startTrayIpcServer(cwd, (msg) => {
  if (msg.type === "turn" && addTurn) {
    addTurn({
      id: Date.now().toString(),
      label: msg.label,
      files: msg.files,
      diffStats: msg.diffStats,
      timestamp: new Date(),
    });
  }
});

function App() {
  const [turns, setTurns] = useState<TurnData[]>([]);

  // Wire the IPC callback into React state
  addTurn = (turn: TurnData) => setTurns((prev) => [...prev, turn]);

  return <TurnTray turns={turns} />;
}

render(<App />);
