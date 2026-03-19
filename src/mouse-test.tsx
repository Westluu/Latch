#!/usr/bin/env node
import React, { useState, useEffect, useCallback } from "react";
import { render, Box, Text, useApp, useInput } from "ink";

type MouseEvt = { x: number; y: number; action: string; button: number };
type MouseListener = (evt: MouseEvt) => void;

const mouseListeners: MouseListener[] = [];

function useMouse(handler: MouseListener) {
  useEffect(() => {
    mouseListeners.push(handler);
    return () => {
      const idx = mouseListeners.indexOf(handler);
      if (idx >= 0) mouseListeners.splice(idx, 1);
    };
  }, [handler]);
}

const FILES = ["README.md", "package.json", "src/cli.ts"];

function MouseTest() {
  const { exit } = useApp();
  const [lastClick, setLastClick] = useState<string>("none");
  const [mousePos, setMousePos] = useState<string>("waiting...");
  const [calibrated, setCalibrated] = useState(false);
  const [fileRows, setFileRows] = useState<number[]>([]);

  useEffect(() => {
    process.stdout.write("\x1b[?1000h");
    process.stdout.write("\x1b[?1006h");

    const origEmit = process.stdin.emit.bind(process.stdin);
    process.stdin.emit = function (event: string, ...args: any[]) {
      if (event === "data") {
        const data = args[0];
        const str = typeof data === "string" ? data : data.toString("utf-8");
        const match = str.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
        if (match) {
          const cb = parseInt(match[1], 10);
          const x = parseInt(match[2], 10) - 1;
          const y = parseInt(match[3], 10) - 1;
          const isRelease = match[4] === "m";
          const isMove = (cb & 32) !== 0;
          const button = cb & 3;

          let action = "down";
          if (isRelease) action = "up";
          else if (isMove) action = "move";

          for (const listener of mouseListeners) {
            listener({ x, y, action, button });
          }
          return false;
        }
      }
      return origEmit(event, ...args);
    } as any;

    return () => {
      process.stdout.write("\x1b[?1000l");
      process.stdout.write("\x1b[?1006l");
      process.stdin.emit = origEmit;
    };
  }, []);

  useInput((input) => {
    if (input === "q") {
      process.stdout.write("\x1b[?1000l");
      process.stdout.write("\x1b[?1006l");
      exit();
    }
    // Press 'c' to calibrate — click the marker line after pressing c
    if (input === "c") {
      setCalibrated(false);
      setLastClick("Click the >>> CALIBRATE <<< line now!");
    }
  });

  const handleMouse = useCallback((evt: MouseEvt) => {
    setMousePos(`x=${evt.x} y=${evt.y}`);

    if (evt.action === "down" && evt.button === 0) {
      if (!calibrated) {
        // Use this click's Y as the calibration row (row 2 in our layout)
        const calRow = evt.y;
        // Files are at calRow+1, calRow+2, calRow+3
        setFileRows(FILES.map((_, i) => calRow + 1 + i));
        setCalibrated(true);
        setLastClick("Calibrated! Now click a file.");
        return;
      }

      // Check if click matches a file row
      const fileIdx = fileRows.indexOf(evt.y);
      if (fileIdx >= 0 && evt.x >= 1) {
        setLastClick(FILES[fileIdx]!);
      } else {
        setLastClick(`(miss at ${evt.x},${evt.y})`);
      }
    }
  }, [calibrated, fileRows]);

  useMouse(handleMouse);

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Mouse Click Test</Text>
      <Text dimColor>Step 1: Click the line below to calibrate</Text>
      <Text color="yellow" bold>{calibrated ? "  ✓ Calibrated" : "  >>> CALIBRATE <<<"}</Text>
      <Text color="cyan"> README.md</Text>
      <Text color="cyan"> package.json</Text>
      <Text color="cyan"> src/cli.ts</Text>
      <Text> </Text>
      <Text>Mouse: {mousePos}</Text>
      <Text>Result: <Text color="green" bold>{lastClick}</Text></Text>
      <Text dimColor>Press c to re-calibrate, q to quit</Text>
    </Box>
  );
}

render(React.createElement(MouseTest));
