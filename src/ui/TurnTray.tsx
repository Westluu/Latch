import React, { useState, useEffect } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { TurnFile } from "../ipc.js";

export interface TurnData {
  id: string;
  label: string;
  files: TurnFile[];
  diffStats: { added: number; removed: number };
  timestamp: Date;
}

const MIN_CARD_OUTER = 28;

function truncate(str: string, max: number): string {
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
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
  const cardInner = cardOuter - 4; // borders + paddingX
  const borderColor = isSelected ? "blue" : "gray";
  const indicator = isSelected ? "●" : "○";
  const fileNames = turn.files.map((f) => f.path.split("/").pop() ?? f.path).join("  ");

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={borderColor}
      width={cardOuter}
      paddingX={1}
    >
      {/* Label */}
      <Text bold={isSelected} color={isSelected ? "blue" : "white"} wrap="truncate">
        {indicator} {truncate(turn.label, cardInner - 2)}
      </Text>

      {/* Stats + files on one line */}
      <Text dimColor wrap="truncate">
        <Text color="green">+{turn.diffStats.added}</Text>
        <Text color="red"> -{turn.diffStats.removed}</Text>
        {"  "}{truncate(fileNames, cardInner - 10)}
      </Text>
    </Box>
  );
}

export default function TurnTray({ turns }: { turns: TurnData[] }) {
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
    if (turns.length > 0) setSelectedIndex(turns.length - 1);
  }, [turns.length]);

  useInput((input, key) => {
    if (input === "q") { exit(); process.exit(0); }
    if (key.leftArrow)  setSelectedIndex((i) => Math.max(0, i - 1));
    if (key.rightArrow) setSelectedIndex((i) => Math.min(turns.length - 1, i + 1));
  });

  // Distribute full width evenly across visible cards
  const visibleCount = Math.max(1, Math.floor(termWidth / MIN_CARD_OUTER));
  const cardOuter = Math.floor(termWidth / visibleCount);
  const scrollStart = Math.max(0, Math.min(selectedIndex, turns.length - visibleCount));
  const visible = turns.slice(scrollStart, scrollStart + visibleCount);

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box>
        <Text bold inverse> LATCH TURN TRAY </Text>
        <Text dimColor>  ←/→ navigate  q quit</Text>
      </Box>

      {/* Cards */}
      <Box flexDirection="row">
        {turns.length === 0 ? (
          <Box borderStyle="single" borderColor="gray" paddingX={1}>
            <Text dimColor>No turns yet — changes will appear here after each Claude response.</Text>
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
