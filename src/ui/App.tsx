import React, { useState, useEffect } from "react";
import { Box, Text, useApp, useInput, useStdout, useFocusManager } from "ink";
import FileList, { type FileEntry } from "./FileList.js";
import Preview from "./Preview.js";
import StatusBar from "./StatusBar.js";
import { getChangedFiles, readFile, getDiff } from "../git.js";
import { cleanupMouseTracking } from "./useMouse.js";

interface AppProps {
  cwd: string;
  onFileOpen?: (handler: (filePath: string) => void) => void;
}

export default function App({ cwd, onFileOpen }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [openedFile, setOpenedFile] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [mode, setMode] = useState<"preview" | "diff">("preview");

  const termHeight = stdout?.rows ?? 24;
  const termWidth = stdout?.columns ?? 80;
  const previewMaxLines = termHeight - 6;
  const fileListWidth = Math.floor(termWidth * 0.4);

  // FileList starts at row 3 (1 for border + 1 for title + 1 for marginBottom)
  const fileListStartRow = 3;

  const { focusNext, focusPrevious } = useFocusManager();

  useEffect(() => {
    const changed = getChangedFiles(cwd);
    setFiles(changed);
  }, [cwd]);

  useEffect(() => {
    if (!onFileOpen) return;
    onFileOpen((filePath: string) => {
      const changed = getChangedFiles(cwd);
      setFiles(changed);
      setOpenedFile(filePath);
      setScrollOffset(0);
      setMode("preview");
      const content = readFile(cwd, filePath);
      setPreviewContent(content ?? "Cannot read file");
      const idx = changed.findIndex((f) => f.path === filePath);
      if (idx >= 0) setSelectedIndex(idx);
    });
  }, [cwd, onFileOpen]);

  useInput((input, key) => {
    if (input === "q") {
      cleanupMouseTracking();
      exit();
    }
    if (key.tab) {
      if (key.shift) {
        focusPrevious();
      } else {
        focusNext();
      }
    }
    if (input === "d") {
      if (openedFile) {
        setMode((m) => (m === "diff" ? "preview" : "diff"));
        setScrollOffset(0);
        if (mode === "preview") {
          const diff = getDiff(cwd, openedFile);
          setPreviewContent(diff ?? "No diff available");
        } else {
          const content = readFile(cwd, openedFile);
          setPreviewContent(content ?? "Cannot read file");
        }
      }
    }
    if (input === "r") {
      const changed = getChangedFiles(cwd);
      setFiles(changed);
      if (openedFile) {
        const content = mode === "diff" ? getDiff(cwd, openedFile) : readFile(cwd, openedFile);
        setPreviewContent(content ?? null);
      }
    }
  });

  const handleOpen = (index: number) => {
    const file = files[index];
    if (!file) return;
    setOpenedFile(file.path);
    setScrollOffset(0);
    setMode("preview");
    const content = readFile(cwd, file.path);
    setPreviewContent(content ?? "Cannot read file");
  };

  return (
    <Box flexDirection="column" height={termHeight}>
      <Box flexGrow={1}>
        <Box width="40%">
          <FileList
            files={files}
            selectedIndex={selectedIndex}
            onSelect={setSelectedIndex}
            onOpen={handleOpen}
            paneWidth={fileListWidth}
            startRow={fileListStartRow}
          />
        </Box>
        <Box flexGrow={1}>
          <Preview
            filePath={openedFile}
            content={previewContent ?? ""}
            scrollOffset={scrollOffset}
            onScroll={setScrollOffset}
            maxLines={previewMaxLines}
            mode={mode}
          />
        </Box>
      </Box>
      <StatusBar mode={mode} filePath={openedFile} />
    </Box>
  );
}
