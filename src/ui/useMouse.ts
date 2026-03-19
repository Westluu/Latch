import { useEffect, useRef } from "react";

export type MouseEvt = {
  x: number;
  y: number;
  action: "down" | "up" | "move";
  button: number;
};

type MouseListener = (evt: MouseEvt) => void;

const listeners: Set<MouseListener> = new Set();
let installed = false;

export function installMouseTracking() {
  if (installed) return;
  installed = true;

  // Enable SGR mouse button tracking
  process.stdout.write("\x1b[?1000h");
  process.stdout.write("\x1b[?1006h");

  // Intercept stdin to catch mouse escape sequences before Ink
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

        let action: MouseEvt["action"] = "down";
        if (isRelease) action = "up";
        else if (isMove) action = "move";

        const evt: MouseEvt = { x, y, action, button };
        for (const listener of listeners) {
          listener(evt);
        }
        return false;
      }
    }
    return origEmit(event, ...args);
  } as any;
}

export function cleanupMouseTracking() {
  process.stdout.write("\x1b[?1000l");
  process.stdout.write("\x1b[?1006l");
}

export function useMouse(handler: MouseListener) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const wrapper: MouseListener = (evt) => handlerRef.current(evt);
    listeners.add(wrapper);
    return () => {
      listeners.delete(wrapper);
    };
  }, []); // Only register once
}
