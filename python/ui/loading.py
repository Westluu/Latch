#!/usr/bin/env python3
"""Latch loading screen — animates a spinner then execs into the agent."""

import os
import sys
import time

try:
    from ._runtime import bootstrap_python_root
except ImportError:
    from _runtime import bootstrap_python_root

bootstrap_python_root()

from latch import theme

LATCH_ASCII = [
    " ██╗      █████╗ ████████╗  ██████╗██╗  ██╗",
    " ██║     ██╔══██╗╚══██╔══╝ ██╔════╝██║  ██║",
    " ██║     ███████║   ██║    ██║     ███████║",
    " ██║     ██╔══██║   ██║    ██║     ██╔══██║",
    " ███████╗██║  ██║   ██║    ╚██████╗██║  ██║",
    " ╚══════╝╚═╝  ╚═╝   ╚═╝     ╚═════╝╚═╝  ╚═╝",
]

SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

PURPLE   = theme.ansi_fg(theme.ACCENT)
DIM      = theme.ansi_fg(theme.TEXT_FAINT)
RESET    = "\033[0m"
HIDE_CUR = "\033[?25l"
SHOW_CUR = "\033[?25h"


def clear() -> None:
    sys.stdout.write("\033[2J\033[H")
    sys.stdout.flush()


def center(text: str, width: int) -> str:
    pad = max(0, (width - len(text)) // 2)
    return " " * pad + text


def main() -> None:
    agent = sys.argv[1] if len(sys.argv) > 1 else "claude"

    try:
        size = os.get_terminal_size()
        cols, rows = size.columns, size.lines
    except OSError:
        cols, rows = 80, 24

    art_height = len(LATCH_ASCII)
    top_pad = max(0, (rows - art_height - 4) // 2)

    sys.stdout.write(HIDE_CUR)
    sys.stdout.flush()

    try:
        start = time.monotonic()
        spin_idx = 0

        while time.monotonic() - start < 0.8:
            clear()

            sys.stdout.write("\n" * top_pad)

            for line in LATCH_ASCII:
                sys.stdout.write(PURPLE + center(line, cols) + RESET + "\n")

            sys.stdout.write("\n")

            spin_char = SPINNER[spin_idx % len(SPINNER)]
            status = f"{spin_char}  starting {agent}..."
            sys.stdout.write(DIM + center(status, cols) + RESET + "\n")

            sys.stdout.flush()
            time.sleep(0.08)
            spin_idx += 1

    finally:
        sys.stdout.write(SHOW_CUR)
        sys.stdout.flush()

    clear()
    os.execlp(agent, agent)


if __name__ == "__main__":
    main()
