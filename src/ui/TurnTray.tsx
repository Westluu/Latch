import React from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";

export interface TurnData {
  id: string;
  label: string;
  files: string[];
  diffStats: { added: number; removed: number };
  timestamp: Date;
}

const CARD_INNER = 26;
const CARD_OUTER = CARD_INNER + 2; // +2 for borders
const MAX_FILES = 3;

function truncate(str: string, max: number): string {
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

function TurnCard({
  turn,
  isSelected,
}: {
  turn: TurnData;
  isSelected: boolean;
}) {
  const borderColor = isSelected ? "blue" : "gray";
  const indicator = isSelected ? "●" : "○";
  const shown = turn.files.slice(0, MAX_FILES);
  const extra = turn.files.length - shown.length;

  // Pad to MAX_FILES rows so every card is the same height
  const padRows = MAX_FILES - shown.length;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={borderColor}
      width={CARD_OUTER}
      paddingX={1}
    >
      {/* Label */}
      <Text bold={isSelected} color={isSelected ? "blue" : "white"} wrap="truncate">
        {indicator} {truncate(turn.label, CARD_INNER - 2)}
      </Text>

      {/* Stats */}
      <Text dimColor>
        {turn.files.length} file{turn.files.length !== 1 ? "s" : ""}{"  "}
        <Text color="green">+{turn.diffStats.added}</Text>
        {" / "}
        <Text color="red">-{turn.diffStats.removed}</Text>
      </Text>

      {/* Spacer */}
      <Text> </Text>

      {/* File list */}
      {shown.map((f) => (
        <Text key={f} dimColor wrap="truncate">
          {">"} {truncate(f, CARD_INNER - 4)}{"  ✓"}
        </Text>
      ))}

      {/* Padding rows */}
      {Array.from({ length: padRows }).map((_, i) => (
        <Text key={i}> </Text>
      ))}

      {/* Overflow */}
      <Text dimColor>{extra > 0 ? `+${extra} more` : " "}</Text>

      {/* Action */}
      <Text dimColor>{isSelected ? "[Enter] review" : " "}</Text>
    </Box>
  );
}

export default function TurnTray({ turns }: { turns: TurnData[] }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;

  const [selectedIndex, setSelectedIndex] = React.useState(0);

  // Auto-select latest turn when a new one arrives
  React.useEffect(() => {
    if (turns.length > 0) setSelectedIndex(turns.length - 1);
  }, [turns.length]);

  useInput((input, key) => {
    if (input === "q") { exit(); process.exit(0); }
    if (key.leftArrow)  setSelectedIndex((i) => Math.max(0, i - 1));
    if (key.rightArrow) setSelectedIndex((i) => Math.min(turns.length - 1, i + 1));
  });

  // How many cards fit across the terminal
  const visibleCount = Math.max(1, Math.floor(termWidth / CARD_OUTER));
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
            />
          ))
        )}
      </Box>
    </Box>
  );
}
