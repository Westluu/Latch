"""
Latch sidecar TUI — file list + diff viewer.

Usage:
    python3 sidecar.py <cwd> [session_id]
"""

from __future__ import annotations

import asyncio
import atexit
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
from typing import Optional

from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, VerticalScroll
from textual.widgets import Footer, Header, ListItem, ListView, Static

# ── IPC helpers ──────────────────────────────────────────────────────────────


def get_socket_dir() -> str:
    base = os.environ.get("XDG_RUNTIME_DIR", tempfile.gettempdir())
    d = os.path.join(base, "latch")
    os.makedirs(d, exist_ok=True)
    return d


def get_socket_path(cwd: str, session_id: str = "") -> str:
    h = hashlib.sha256((cwd + session_id).encode()).hexdigest()[:12]
    return os.path.join(get_socket_dir(), f"{h}-sidecar.sock")


async def start_ipc_server(socket_path: str, on_message):
    if os.path.exists(socket_path):
        os.unlink(socket_path)

    async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        buffer = ""
        while True:
            data = await reader.read(4096)
            if not data:
                break
            buffer += data.decode()
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                line = line.strip()
                if line:
                    try:
                        msg = json.loads(line)
                        await on_message(msg)
                        writer.write(b"ok\n")
                        await writer.drain()
                    except json.JSONDecodeError:
                        writer.write(b"error: invalid json\n")
                        await writer.drain()
        writer.close()

    server = await asyncio.start_unix_server(handle_client, path=socket_path)
    return server


# ── Git helpers ───────────────────────────────────────────────────────────────

STATUS_LABEL = {
    "M": "M",
    "A": "A",
    "D": "D",
    "?": "?",
    "AM": "A",
    "MM": "M",
    "R": "M",
}

STATUS_COLORS = {
    "modified": "#F59E0B",
    "added": "#10B981",
    "deleted": "#EF4444",
    "untracked": "#6B7280",
}

STATUS_MAP = {
    "M": "modified",
    "A": "added",
    "D": "deleted",
    "?": "untracked",
    "AM": "added",
    "MM": "modified",
    "R": "modified",
}


def get_changed_files(cwd: str) -> list[dict]:
    result = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=cwd,
        capture_output=True,
        text=True,
    )
    files = []
    for line in result.stdout.splitlines():
        if not line:
            continue
        xy = line[:2].strip()
        path = line[3:]
        # Handle rename "old -> new" format
        if " -> " in path:
            path = path.split(" -> ")[-1]
        status = STATUS_MAP.get(xy, "modified")
        label = STATUS_LABEL.get(xy, "M")
        files.append({"path": path, "status": status, "label": label})
    return files


def get_diff(cwd: str, file_path: str) -> str:
    # Try staged first, then unstaged
    for args in [
        ["git", "diff", "--cached", "--", file_path],
        ["git", "diff", "--", file_path],
    ]:
        r = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
        if r.stdout.strip():
            return r.stdout
    # Untracked: show file contents with + prefix
    full = os.path.join(cwd, file_path)
    if os.path.exists(full):
        try:
            with open(full) as f:
                return "\n".join(f"+ {l.rstrip()}" for l in f)
        except Exception:
            return "(binary or unreadable file)"
    return "(no diff available)"


def render_diff(diff_text: str) -> Text:
    text = Text()
    for line in diff_text.splitlines():
        if line.startswith("+++") or line.startswith("---"):
            text.append(line + "\n", style="#6B7280")
        elif line.startswith("+"):
            text.append(line + "\n", style="#10B981 on #0D2818")
        elif line.startswith("-"):
            text.append(line + "\n", style="#EF4444 on #2D1A1A")
        elif line.startswith("@@"):
            text.append(line + "\n", style="bold #3B82F6")
        else:
            text.append(line + "\n", style="#6B7280")
    return text


# ── Custom ListItem ───────────────────────────────────────────────────────────


class FileListItem(ListItem):
    """A list item that carries the file path as an attribute."""

    def __init__(
        self, file_path: str, status: str, label: str, max_width: int = 20
    ) -> None:
        self.file_path = file_path
        color = STATUS_COLORS.get(status, "#6B7280")
        name = os.path.basename(file_path)
        display = name if len(name) <= 10 else name[:6] + "…"
        markup = f"[bold {color}]{label}[/]  {display}"
        super().__init__(Static(markup))


# ── Main App ──────────────────────────────────────────────────────────────────

CSS = """
Screen {
    background: #111827;
}

#file-list {
    width: 28%;
    border: round #4B5563;
    padding: 0 1;
}

#file-list:focus-within {
    border: round #7C3AED;
}

#diff-view {
    width: 72%;
    border: round #4B5563;
    overflow-y: scroll;
}

#diff-view:focus-within {
    border: round #7C3AED;
}

ListView > ListItem {
    padding: 0 1;
    background: transparent;
}

ListView > ListItem.--highlight {
    background: #374151;
}
"""


class SidecarApp(App):
    CSS = CSS

    BINDINGS = [
        Binding("q", "quit", "Quit"),
        Binding("r", "refresh", "Refresh"),
        Binding("j", "cursor_down", "Down"),
        Binding("k", "cursor_up", "Up"),
        Binding("tab", "focus_next", "Switch pane"),
    ]

    def __init__(self, cwd: str, session_id: str = "") -> None:
        super().__init__()
        self.cwd = cwd
        self.session_id = session_id
        self._files: list[dict] = []
        self._selected_path: Optional[str] = None
        self._ipc_server = None
        self._socket_path = get_socket_path(cwd, session_id)

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Horizontal():
            yield ListView(id="file-list")
            with VerticalScroll(id="diff-view"):
                yield Static("", id="diff-content")
        yield Footer()

    async def on_mount(self) -> None:
        self.title = "LATCH"
        await self.refresh_files()
        asyncio.get_event_loop().create_task(self._start_ipc())

    async def _start_ipc(self) -> None:
        async def on_message(msg: dict) -> None:
            if msg.get("type") == "open":
                file_path = msg.get("filePath", "")
                await self.refresh_files()
                self._select_file_by_path(file_path)
            elif msg.get("type") == "refresh":
                await self.refresh_files()
                if self._selected_path:
                    self._select_file_by_path(self._selected_path)

        try:
            self._ipc_server = await start_ipc_server(self._socket_path, on_message)
            async with self._ipc_server:
                await self._ipc_server.serve_forever()
        except Exception:
            pass

    async def refresh_files(self) -> None:
        self._files = get_changed_files(self.cwd)
        list_view = self.query_one("#file-list", ListView)
        max_w = list_view.size.width or self.size.width // 4
        await list_view.clear()
        for f in self._files:
            item = FileListItem(f["path"], f["status"], f["label"], max_width=max_w)
            await list_view.append(item)
        if self._files and self._selected_path is None:
            list_view.index = 0
            self._load_diff(self._files[0]["path"])

    def _select_file_by_path(self, file_path: str) -> None:
        list_view = self.query_one("#file-list", ListView)
        for i, f in enumerate(self._files):
            if f["path"] == file_path or f["path"].endswith(file_path):
                list_view.index = i
                self._load_diff(f["path"])
                break

    def _load_diff(self, file_path: str) -> None:
        self._selected_path = file_path
        self.sub_title = file_path
        diff_text = get_diff(self.cwd, file_path)
        rendered = render_diff(diff_text)
        self.query_one("#diff-content", Static).update(rendered)

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        item = event.item
        if isinstance(item, FileListItem):
            self._load_diff(item.file_path)

    def action_refresh(self) -> None:
        self.run_worker(self.refresh_files(), exclusive=True)

    def action_cursor_down(self) -> None:
        list_view = self.query_one("#file-list", ListView)
        list_view.action_cursor_down()

    def action_cursor_up(self) -> None:
        list_view = self.query_one("#file-list", ListView)
        list_view.action_cursor_up()


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 sidecar.py <cwd> [session_id]", file=sys.stderr)
        sys.exit(1)

    cwd = os.path.abspath(sys.argv[1])
    session_id = sys.argv[2] if len(sys.argv) > 2 else ""
    if not os.path.isdir(cwd):
        print(f"Error: {cwd!r} is not a directory", file=sys.stderr)
        sys.exit(1)

    socket_path = get_socket_path(cwd, session_id)

    def cleanup_socket():
        try:
            if os.path.exists(socket_path):
                os.unlink(socket_path)
        except OSError:
            pass

    atexit.register(cleanup_socket)
    signal.signal(signal.SIGHUP, lambda *_: (cleanup_socket(), sys.exit(0)))
    signal.signal(signal.SIGTERM, lambda *_: (cleanup_socket(), sys.exit(0)))

    app = SidecarApp(cwd, session_id)
    app.run()
