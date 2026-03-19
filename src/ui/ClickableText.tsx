import React, { useState, useRef, useEffect } from "react";
import { Box, Text, useInput, useStdout } from "ink";

interface ClickableTextProps {
  text: string;
  row: number; // expected row position in terminal
  col: number; // expected col start position
  onClick: () => void;
  color?: string;
}

export default function ClickableText({ text, row, col, onClick, color = "cyan" }: ClickableTextProps) {
  const [hovered, setHovered] = useState(false);

  useInput((_input, key) => {
    if (key.mouse) {
      const { x, y, action } = key.mouse as { x: number; y: number; action: string };

      const isInRange = y === row && x >= col && x < col + text.length;

      if (action === "down" && isInRange) {
        onClick();
      }

      setHovered(isInRange);
    }
  });

  return (
    <Text color={color} underline={hovered} bold={hovered}>
      {text}
    </Text>
  );
}
