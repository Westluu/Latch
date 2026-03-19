import React, { useCallback } from "react";
import { Box, Text, useFocus, useInput } from "ink";
import { useMouse, type MouseEvt } from "./useMouse.js";

export interface FileEntry {
  path: string;
  status: "modified" | "added" | "deleted" | "untracked";
}

interface FileListProps {
  files: FileEntry[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onOpen: (index: number) => void;
  paneWidth: number;
  startRow: number;
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

function truncate(str: string, maxWidth: number): string {
  if (str.length <= maxWidth) return str;
  return str.slice(0, maxWidth - 1) + "…";
}

export default function FileList({ files, selectedIndex, onSelect, onOpen, paneWidth, startRow }: FileListProps) {
  const { isFocused } = useFocus({ id: "file-list", autoFocus: true });

  const maxTextWidth = paneWidth - 4;

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

  const handleMouse = useCallback(
    (evt: MouseEvt) => {
      if (evt.x >= paneWidth) return;

      if (evt.action === "down" && evt.button === 0) {
        const fileIdx = evt.y - startRow;
        if (fileIdx >= 0 && fileIdx < files.length) {
          onSelect(fileIdx);
          onOpen(fileIdx);
        }
      }
    },
    [files.length, onSelect, onOpen, paneWidth, startRow]
  );

  useMouse(handleMouse);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={isFocused ? "blue" : "gray"} paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color={isFocused ? "blue" : "white"} wrap="truncate">
          Changed Files ({files.length})
        </Text>
      </Box>
      {files.length === 0 ? (
        <Text dimColor>No changed files</Text>
      ) : (
        files.map((file, i) => {
          const isSelected = i === selectedIndex;
          const color = statusColors[file.status];
          const label = `${statusLabels[file.status]} ${file.path}`;
          return (
            <Box key={file.path}>
              <Text
                color={color}
                bold={isSelected}
                inverse={isSelected && isFocused}
                wrap="truncate"
              >
                {truncate(label, maxTextWidth)}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
