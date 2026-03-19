import React from "react";
import { Box, Text, useFocus, useInput } from "ink";

export interface FileEntry {
  path: string;
  status: "modified" | "added" | "deleted" | "untracked";
}

interface FileListProps {
  files: FileEntry[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onOpen: (index: number) => void;
}

const statusColors: Record<FileEntry["status"], string> = {
  modified: "yellow",
  added: "green",
  deleted: "red",
  untracked: "gray",
};

const statusLabels: Record<FileEntry["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  untracked: "?",
};

export default function FileList({ files, selectedIndex, onSelect, onOpen }: FileListProps) {
  const { isFocused } = useFocus({ id: "file-list", autoFocus: true });

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") {
        onSelect(Math.max(0, selectedIndex - 1));
      } else if (key.downArrow || input === "j") {
        onSelect(Math.min(files.length - 1, selectedIndex + 1));
      } else if (key.return) {
        onOpen(selectedIndex);
      }
    },
    { isActive: isFocused }
  );

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={isFocused ? "blue" : "gray"} paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color={isFocused ? "blue" : "white"}>
          Changed Files ({files.length})
        </Text>
      </Box>
      {files.length === 0 ? (
        <Text dimColor>No changed files</Text>
      ) : (
        files.map((file, i) => {
          const isSelected = i === selectedIndex;
          const color = statusColors[file.status];
          return (
            <Box key={file.path}>
              <Text
                color={color}
                bold={isSelected}
                inverse={isSelected && isFocused}
              >
                {statusLabels[file.status]} {file.path}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
