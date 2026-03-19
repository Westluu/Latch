import React from "react";
import { Box, Text } from "ink";

interface StatusBarProps {
  mode: "preview" | "diff";
  filePath: string | null;
}

export default function StatusBar({ mode, filePath }: StatusBarProps) {
  return (
    <Box>
      <Text bold inverse color="white">
        {" "}LATCH{" "}
      </Text>
      <Text> </Text>
      <Text dimColor>
        Tab:focus  j/k:navigate  Enter:open  d:diff  o:editor  q:quit
      </Text>
    </Box>
  );
}
