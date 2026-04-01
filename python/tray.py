"""
Latch turn tray TUI — horizontal card view of Claude Code turns.

Usage:
    python3 tray.py <cwd> <session_id>
"""

from __future__ import annotations

import asyncio
import atexit
import os
import signal
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime

from latch.ipc import build_socket_path, cleanup_socket, send_json_message, start_ipc_server
from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.widgets import Footer, Header, Static


async def send_to_sidecar(cwd: str, session_id: str, msg: dict) -> None:
    """Send a message to the sidecar's IPC socket."""
    sock_path = build_socket_path(cwd, "sidecar", session_id)
    await send_json_message(sock_path, msg)


# ── Data model ────────────────────────────────────────────────────────────────

@dataclass
class TurnData:
    id: str
    label: str
    files: list  # list of {"path", "backupFile", "isNew"} dicts
    diff_stats: dict  # {"added": int, "removed": int}
    timestamp: datetime
    reverted: bool = False


# ── Revert logic ──────────────────────────────────────────────────────────────

def revert_from(turns: list[TurnData], from_index: int) -> list[TurnData]:
    """Revert turns from from_index onward, processing newest to oldest."""
    to_revert = list(reversed(turns[from_index:]))
    for turn in to_revert:
        if turn.reverted:
            continue
        for f in turn.files:
            try:
                if f["backupFile"] is None:
                    # File was created this turn — delete it
                    if os.path.exists(f["path"]):
                        os.unlink(f["path"])
                elif os.path.exists(f["backupFile"]):
                    # Restore from backup
                    shutil.copy2(f["backupFile"], f["path"])
            except Exception:
                pass
    for i in range(from_index, len(turns)):
        turns[i].reverted = True
    return turns


# ── Card rendering ────────────────────────────────────────────────────────────

CARD_WIDTH = 30
FILE_ICON = ">"


def _file_status_char(f: dict) -> str:
    if f.get("isNew"):
        return "[bold #10B981]+[/]"
    if f.get("backupFile") is None and not f.get("isNew"):
        return "[bold #EF4444]x[/]"
    return "[bold #10B981]v[/]"


def render_card(turn: TurnData, selected: bool) -> Text:
    """Render a single turn card as Rich Text."""
    border_color = "#7C3AED" if selected else "#4B5563"
    dim = turn.reverted

    lines: list[str] = []

    # Top border
    lines.append(f"[{border_color}]{'─' * (CARD_WIDTH - 2)}[/]")

    # Label line
    label = turn.label
    if len(label) > CARD_WIDTH - 6:
        label = label[: CARD_WIDTH - 9] + "..."
    status_dot = "[#6B7280]●[/]" if turn.reverted else "[#7C3AED]●[/]"
    lines.append(f" {status_dot} {label}")

    # Stats line
    added = turn.diff_stats.get("added", 0)
    removed = turn.diff_stats.get("removed", 0)
    file_count = len(turn.files)
    stats = (
        f" [#6B7280]{file_count} file{'s' if file_count != 1 else ''}[/]"
        f"  [#10B981]+{added}[/] / [#EF4444]-{removed}[/]"
    )
    lines.append(stats)

    # Blank line
    lines.append("")

    # File list (up to 5 files)
    shown_files = turn.files[:5]
    for f in shown_files:
        raw_path = f.get("path", "")
        base = os.path.basename(raw_path)
        if len(base) > CARD_WIDTH - 8:
            base = base[: CARD_WIDTH - 11] + "..."
        icon_markup = _file_status_char(f)
        lines.append(f" [#6B7280]{FILE_ICON}[/] {base:<{CARD_WIDTH - 8}} {icon_markup}")

    if len(turn.files) > 5:
        extra = len(turn.files) - 5
        lines.append(f" [#6B7280]  ... and {extra} more[/]")

    # Blank line
    lines.append("")

    # Action hints
    if turn.reverted:
        lines.append(" [#6B7280](reverted)[/]")
    else:
        lines.append(" [#6B7280][[/][#F59E0B]r[/][#6B7280]] revert  [[/][#F59E0B]↵[/][#6B7280]] review[/]")

    # Bottom border
    lines.append(f"[{border_color}]{'─' * (CARD_WIDTH - 2)}[/]")

    markup = "\n".join(lines)
    text = Text.from_markup(markup)
    if dim:
        text.stylize("dim")
    return text


# ── Card widget ───────────────────────────────────────────────────────────────

class TurnCard(Static):
    """A static widget representing a single turn card."""

    DEFAULT_CSS = f"""
    TurnCard {{
        width: {CARD_WIDTH + 4};
        height: auto;
        margin: 1 1;
        padding: 1;
        border: round #4B5563;
    }}
    TurnCard.selected {{
        border: round #7C3AED;
    }}
    """

    def __init__(self, turn: TurnData, selected: bool = False) -> None:
        self.turn = turn
        super().__init__(render_card(turn, selected))
        if selected:
            self.add_class("selected")

    def refresh_card(self, selected: bool) -> None:
        self.update(render_card(self.turn, selected))
        if selected:
            self.add_class("selected")
        else:
            self.remove_class("selected")


# ── Main App ──────────────────────────────────────────────────────────────────

CSS = """
Screen {
    background: #111827;
}

#tray-scroll {
    height: 1fr;
    overflow-x: scroll;
    overflow-y: hidden;
}

#cards-row {
    height: auto;
    layout: horizontal;
}

#empty-hint {
    color: #4B5563;
    margin: 2 4;
    text-align: center;
}
"""


class TrayApp(App):
    CSS = CSS

    BINDINGS = [
        Binding("left,h", "prev_card", "Previous"),
        Binding("right,l", "next_card", "Next"),
        Binding("r", "revert", "Revert"),
        Binding("enter", "review", "Review"),
        Binding("q", "quit", "Quit"),
    ]

    def __init__(self, cwd: str, session_id: str) -> None:
        super().__init__()
        self.cwd = cwd
        self.session_id = session_id
        self._turns: list[TurnData] = []
        self._selected_index: int = 0
        self._ipc_server = None
        self._socket_path = build_socket_path(cwd, "tray", session_id)

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Horizontal(id="tray-scroll"):
            yield Horizontal(id="cards-row")
            yield Static("Waiting for Claude to make changes…", id="empty-hint")
        yield Footer()

    async def on_mount(self) -> None:
        self.title = "LATCH TURN TRAY"
        asyncio.get_event_loop().create_task(self._start_ipc())

    async def _start_ipc(self) -> None:
        async def on_message(msg: dict) -> None:
            if msg.get("type") == "turn":
                turn = TurnData(
                    id=f"turn-{len(self._turns)}",
                    label=msg.get("label", "(no label)"),
                    files=msg.get("files", []),
                    diff_stats=msg.get("diffStats", {"added": 0, "removed": 0}),
                    timestamp=datetime.utcnow(),
                )
                # Prepend newest turn at index 0
                self._turns.insert(0, turn)
                self._selected_index = 0
                self._rebuild_cards()

        try:
            self._ipc_server = await start_ipc_server(self._socket_path, on_message)
            async with self._ipc_server:
                await self._ipc_server.serve_forever()
        except Exception:
            pass

    def _rebuild_cards(self) -> None:
        """Remove and re-add all TurnCard widgets to reflect current state."""
        row = self.query_one("#cards-row", Horizontal)
        hint = self.query_one("#empty-hint", Static)

        for card in row.query(TurnCard):
            card.remove()

        if not self._turns:
            hint.display = True
            return

        hint.display = False
        for i, turn in enumerate(self._turns):
            card = TurnCard(turn, selected=(i == self._selected_index))
            row.mount(card)

    def _update_selection(self, new_index: int) -> None:
        if not self._turns:
            return
        new_index = max(0, min(new_index, len(self._turns) - 1))
        old_index = self._selected_index
        self._selected_index = new_index

        cards = list(self.query(TurnCard))
        if old_index < len(cards):
            cards[old_index].refresh_card(selected=False)
        if new_index < len(cards):
            cards[new_index].refresh_card(selected=True)
            cards[new_index].scroll_visible()

    def action_prev_card(self) -> None:
        self._update_selection(self._selected_index - 1)

    def action_next_card(self) -> None:
        self._update_selection(self._selected_index + 1)

    async def action_revert(self) -> None:
        if not self._turns:
            return
        idx = self._selected_index
        if self._turns[idx].reverted:
            self.notify("Turn already reverted", severity="warning")
            return
        self._turns = revert_from(self._turns, idx)
        self._rebuild_cards()
        self.notify(f"Reverted {len(self._turns) - idx} turn(s)")
        await send_to_sidecar(self.cwd, self.session_id, {"type": "refresh"})

    def action_review(self) -> None:
        if not self._turns:
            return
        turn = self._turns[self._selected_index]
        paths = [f["path"] for f in turn.files]
        self.notify("Files:\n" + "\n".join(paths) if paths else "No files in turn")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 tray.py <cwd> <session_id>", file=sys.stderr)
        sys.exit(1)

    cwd = os.path.abspath(sys.argv[1])
    session_id = sys.argv[2]

    if not os.path.isdir(cwd):
        print(f"Error: {cwd!r} is not a directory", file=sys.stderr)
        sys.exit(1)

    socket_path = build_socket_path(cwd, "tray", session_id)

    atexit.register(cleanup_socket, socket_path)
    signal.signal(signal.SIGHUP, lambda *_: (cleanup_socket(socket_path), sys.exit(0)))
    signal.signal(signal.SIGTERM, lambda *_: (cleanup_socket(socket_path), sys.exit(0)))

    app = TrayApp(cwd, session_id)
    app.run()
