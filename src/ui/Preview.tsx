import React from "react";
import { Box, Text, useFocus, useInput } from "ink";

interface PreviewProps {
  filePath: string | null;
  content: string;
  scrollOffset: number;
  onScroll: (offset: number) => void;
  maxLines: number;
  mode?: "preview" | "diff";
}

export default function Preview({ filePath, content, scrollOffset, onScroll, maxLines, mode = "preview" }: PreviewProps) {
  const { isFocused } = useFocus({ id: "preview" });

  const lines = content.split("\n");
  const totalLines = lines.length;
  const visibleLines = lines.slice(scrollOffset, scrollOffset + maxLines);

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") {
        onScroll(Math.max(0, scrollOffset - 1));
      } else if (key.downArrow || input === "j") {
        onScroll(Math.min(Math.max(0, totalLines - maxLines), scrollOffset + 1));
      } else if (key.pageDown) {
        onScroll(Math.min(Math.max(0, totalLines - maxLines), scrollOffset + maxLines));
      } else if (key.pageUp) {
        onScroll(Math.max(0, scrollOffset - maxLines));
      }
    },
    { isActive: isFocused }
  );

  const title = filePath
    ? mode === "diff"
      ? `Diff: ${filePath}`
      : `Preview: ${filePath}`
    : "Preview";

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={isFocused ? "blue" : "gray"} paddingX={1} flexGrow={1}>
      <Box marginBottom={1}>
        <Text bold color={isFocused ? "blue" : "white"}>
          {title}
        </Text>
        {filePath && totalLines > maxLines && (
          <Text dimColor>
            {" "}[{scrollOffset + 1}-{Math.min(scrollOffset + maxLines, totalLines)}/{totalLines}]
          </Text>
        )}
      </Box>
      {!filePath ? (
        <Text dimColor>Select a file to preview</Text>
      ) : (
        visibleLines.map((line, i) => {
          const lineNum = scrollOffset + i + 1;
          if (mode === "diff") {
            let color: string | undefined;
            if (line.startsWith("+")) color = "green";
            else if (line.startsWith("-")) color = "red";
            else if (line.startsWith("@@")) color = "cyan";
            return (
              <Box key={`${lineNum}-${i}`}>
                <Text color={color}>{line}</Text>
              </Box>
            );
          }
          return (
            <Box key={`${lineNum}-${i}`}>
              <Text dimColor>{String(lineNum).padStart(4)} </Text>
              <Text>{line}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
