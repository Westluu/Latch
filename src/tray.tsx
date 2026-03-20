#!/usr/bin/env node
import React, { useState } from "react";
import { render } from "ink";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import TurnTray, { type TurnData } from "./ui/TurnTray.js";
import { startTrayIpcServer } from "./ipc.js";

const cwd = process.argv[2] || process.cwd();
const sessionId = process.argv[3] || "";

let addTurn: ((turn: TurnData) => void) | null = null;

startTrayIpcServer(cwd, sessionId, (msg) => {
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

// Restore files for all turns from fromIndex to end (stack-based)
function revertFrom(turns: TurnData[], fromIndex: number): TurnData[] {
  // Process newest → oldest so later changes are undone first
  const toRevert = turns.slice(fromIndex).reverse();

  for (const turn of toRevert) {
    if (turn.reverted) continue;
    for (const file of turn.files) {
      try {
        if (file.backupFile === null) {
          // File was created this turn — revert = delete
          if (existsSync(file.path)) unlinkSync(file.path);
        } else if (existsSync(file.backupFile)) {
          // File was edited — restore from Claude's backup
          writeFileSync(file.path, readFileSync(file.backupFile));
        }
      } catch {
        // Skip files we can't restore (permissions, missing backup, etc.)
      }
    }
  }

  return turns.map((t, i) => (i >= fromIndex ? { ...t, reverted: true } : t));
}

function App() {
  const [turns, setTurns] = useState<TurnData[]>([]);

  addTurn = (turn: TurnData) => setTurns((prev) => [turn, ...prev]);

  function handleRevert(index: number) {
    setTurns((prev) => revertFrom(prev, index));
  }

  return <TurnTray turns={turns} onRevert={handleRevert} />;
}

render(<App />);
