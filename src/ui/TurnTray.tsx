import React, { useState, useEffect } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { TurnFile } from "../ipc.js";

export interface TurnData {
  id: string;
  label: string;
  files: TurnFile[];
  diffStats: { added: number; removed: number };
  timestamp: Date;
  reverted?: boolean;
}

const MIN_CARD_OUTER = 26;
const MAX_FILES_SHOWN = 3;

function truncate(str: string, max: number): string {
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

function TurnCard({
  turn,
  isSelected,
  cardOuter,
}: {
  turn: TurnData;
  isSelected: boolean;
  cardOuter: number;
}) {
  const inner = cardOuter - 4; // borders (2) + paddingX (2)
  const borderColor = turn.reverted ? "gray" : isSelected ? "cyan" : "gray";
  const indicator = isSelected ? "●" : "○";
  const fileCount = turn.files.length;
  const shown = turn.files.slice(0, MAX_FILES_SHOWN);
  const overflow = fileCount - MAX_FILES_SHOWN;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={borderColor}
      width={cardOuter}
      paddingX={1}
    >
      {/* Line 1: indicator + label */}
      <Text bold={isSelected} color={isSelected ? "cyan" : "white"} wrap="truncate">
        {indicator} {truncate(turn.label, inner - 2)}
      </Text>

      {/* Line 2: file count + diff stats */}
      <Text dimColor>
        {fileCount} file{fileCount !== 1 ? "s" : ""}{"  "}
        <Text color="green">+{turn.diffStats.added}</Text>
        {" / "}
        <Text color="red">-{turn.diffStats.removed}</Text>
      </Text>

      {/* Spacer */}
      <Text> </Text>

      {/* File list */}
      {shown.map((f) => (
        <Text key={f.path} wrap="truncate">
          <Text dimColor>{"> "}</Text>
          <Text>{truncate(basename(f.path), inner - 6)}</Text>
          {"  "}
          <Text color={f.isNew ? "yellow" : "green"}>
            {f.isNew ? "+" : "✓"}
          </Text>
        </Text>
      ))}

      {/* Overflow */}
      {overflow > 0 ? (
        <Text dimColor>+{overflow} more</Text>
      ) : (
        // Pad so all cards are same height
        <Text> </Text>
      )}

      {/* Action hint */}
      <Text dimColor wrap="truncate">
        {turn.reverted
          ? "reverted"
          : isSelected
          ? "[r] revert  [Enter] review"
          : "[Enter] review"}
      </Text>
    </Box>
  );
}

export default function TurnTray({
  turns,
  onRevert,
}: {
  turns: TurnData[];
  onRevert: (index: number) => void;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [termWidth, setTermWidth] = useState(stdout?.columns ?? 80);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setTermWidth(stdout.columns ?? 80);
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  const [selectedIndex, setSelectedIndex] = useState(0);

  // Auto-select latest turn when a new one arrives
  useEffect(() => {
    if (turns.length > 0) setSelectedIndex(0);
  }, [turns.length]);

  useInput((input, key) => {
    if (input === "q") { exit(); process.exit(0); }
    if (key.leftArrow)  setSelectedIndex((i) => Math.max(0, i - 1));
    if (key.rightArrow) setSelectedIndex((i) => Math.min(turns.length - 1, i + 1));
    if (input === "r" && turns.length > 0) {
      const turn = turns[selectedIndex];
      if (turn && !turn.reverted) onRevert(selectedIndex);
    }
  });

  const visibleCount = Math.max(1, Math.floor(termWidth / MIN_CARD_OUTER));
  const cardOuter = Math.floor(termWidth / visibleCount);
  const scrollStart = Math.max(0, Math.min(selectedIndex, turns.length - visibleCount));
  const visible = turns.slice(scrollStart, scrollStart + visibleCount);

  return (
    <Box flexDirection="column">
      {/* Header bar */}
      <Box>
        <Text bold inverse> LATCH TURN TRAY </Text>
        <Text dimColor>  ←/→ navigate  r revert  q quit</Text>
      </Box>

      {/* Cards row */}
      <Box flexDirection="row">
        {turns.length === 0 ? (
          <Box borderStyle="single" borderColor="gray" paddingX={1}>
            <Text dimColor>Waiting for Claude to make changes…</Text>
          </Box>
        ) : (
          visible.map((turn, i) => (
            <TurnCard
              key={turn.id}
              turn={turn}
              isSelected={scrollStart + i === selectedIndex}
              cardOuter={cardOuter}
            />
          ))
        )}
      </Box>
    </Box>
  );
}
