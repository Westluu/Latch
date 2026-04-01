"""
Latch sidecar TUI — file list + diff viewer + plans viewer.

Usage:
    python3 sidecar.py <cwd> [session_id]
"""

from __future__ import annotations

import asyncio
import atexit
import glob
import hashlib
import json
import os
import signal
import subprocess
import sys
import tempfile
from typing import Optional

from claude_paths import find_transcript_path
from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, VerticalScroll
from textual.widgets import Footer, Header, ListItem, ListView, Markdown, Static

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
        if " -> " in path:
            path = path.split(" -> ")[-1]
        status = STATUS_MAP.get(xy, "modified")
        label = STATUS_LABEL.get(xy, "M")
        files.append({"path": path, "status": status, "label": label})
    return files


def get_diff(cwd: str, file_path: str) -> str:
    for args in [
        ["git", "diff", "--cached", "--", file_path],
        ["git", "diff", "--", file_path],
    ]:
        r = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
        if r.stdout.strip():
            return r.stdout
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


# ── Plans helpers ─────────────────────────────────────────────────────────────

PLANS_DIR = os.path.join(os.path.expanduser("~"), ".claude", "plans")


def get_session_plan_path(cwd: str, session_id: str) -> Optional[str]:
    """
    Derive the plan file for this specific session by reading the slug from
    the session transcript. Returns the plan path if the file exists, else None.
    """
    if not session_id:
        return None
    transcript = find_transcript_path(cwd, session_id)
    if not transcript:
        return None
    try:
        with open(transcript) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    slug = obj.get("slug")
                    if slug:
                        plan_path = os.path.join(PLANS_DIR, f"{slug}.md")
                        return plan_path  # return even if file doesn't exist yet
                except Exception:
                    pass
    except Exception:
        pass
    return None


def read_plan(plan_path: str) -> str:
    try:
        with open(plan_path) as f:
            return f.read()
    except Exception:
        return "*Could not read plan file.*"


# ── Custom ListItem widgets ───────────────────────────────────────────────────


class FileListItem(ListItem):
    def __init__(self, file_path: str, status: str, label: str, max_width: int = 20) -> None:
        self.file_path = file_path
        color = STATUS_COLORS.get(status, "#6B7280")
        name = os.path.basename(file_path)
        display = name if len(name) <= 10 else name[:6] + "…"
        markup = f"[bold {color}]{label}[/]  {display}"
        super().__init__(Static(markup))


class PlanListItem(ListItem):
    def __init__(self, plan_path: str) -> None:
        self.plan_path = plan_path
        slug = os.path.basename(plan_path).replace(".md", "")
        display = slug if len(slug) <= 24 else slug[:21] + "…"
        markup = f"[#A78BFA]▸[/] {display}"
        super().__init__(Static(markup))


# ── Main App ──────────────────────────────────────────────────────────────────

CSS = """
Screen {
    background: #111827;
}

#tab-bar {
    height: 1;
    background: #1F2937;
}

#tab-files {
    width: 50%;
    content-align: center middle;
    background: #1F2937;
    color: #6B7280;
}

#tab-files.active {
    background: #7C3AED;
    color: #F9FAFB;
}

#tab-plans {
    width: 50%;
    content-align: center middle;
    background: #1F2937;
    color: #6B7280;
}

#tab-plans.active {
    background: #7C3AED;
    color: #F9FAFB;
}

#files-panel {
    display: block;
}

#plans-panel {
    display: none;
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

#plan-list {
    width: 28%;
    border: round #4B5563;
    padding: 0 1;
}

#plan-list:focus-within {
    border: round #7C3AED;
}

#plan-view {
    width: 72%;
    border: round #4B5563;
    overflow-y: scroll;
    padding: 0 1;
}

#plan-view:focus-within {
    border: round #7C3AED;
}

#plan-view Markdown {
    background: transparent;
}

#plan-empty {
    color: #4B5563;
    padding: 1 2;
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
        Binding("1", "show_files", "Files"),
        Binding("2", "show_plans", "Plans"),
    ]

    def __init__(self, cwd: str, session_id: str = "") -> None:
        super().__init__()
        self.cwd = cwd
        self.session_id = session_id
        self._files: list[dict] = []
        self._plan_files: list[str] = []
        self._selected_path: Optional[str] = None
        self._active_tab: str = "files"
        # Derive session plan path upfront (may not exist yet)
        self._session_plan_path: Optional[str] = get_session_plan_path(cwd, session_id)
        self._ipc_server = None
        self._socket_path = get_socket_path(cwd, session_id)

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Horizontal(id="tab-bar"):
            yield Static("[1] Files", id="tab-files", classes="active")
            yield Static("[2] Plans", id="tab-plans")
        with Horizontal(id="files-panel"):
            yield ListView(id="file-list")
            with VerticalScroll(id="diff-view"):
                yield Static("", id="diff-content")
        with Horizontal(id="plans-panel"):
            yield ListView(id="plan-list")
            with VerticalScroll(id="plan-view"):
                yield Markdown("", id="plan-markdown")
                yield Static("No plan for this session yet.", id="plan-empty")
        yield Footer()

    async def on_mount(self) -> None:
        self.title = "LATCH"
        await self.refresh_files()
        await self.refresh_plans()
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
            elif msg.get("type") == "plan":
                plan_file_path = msg.get("planFilePath", "")
                # Update the session plan path in case it wasn't resolved at startup
                if plan_file_path:
                    self._session_plan_path = plan_file_path
                await self.refresh_plans()
                self._switch_to_plans()
                if self._plan_files:
                    self._load_plan(self._plan_files[0])
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

    async def refresh_plans(self) -> None:
        """Show only the plan file for this session."""
        plan_list = self.query_one("#plan-list", ListView)
        await plan_list.clear()
        self._plan_files = []

        plan_path = self._session_plan_path
        if plan_path and os.path.exists(plan_path):
            self._plan_files = [plan_path]
            await plan_list.append(PlanListItem(plan_path))
            plan_list.index = 0
            self._load_plan(plan_path)
            self.query_one("#plan-empty").display = False
            self.query_one("#plan-markdown").display = True
        else:
            self.query_one("#plan-empty").display = True
            self.query_one("#plan-markdown").display = False

    def _switch_to_files(self) -> None:
        self._active_tab = "files"
        self.query_one("#files-panel").display = True
        self.query_one("#plans-panel").display = False
        self.query_one("#tab-files").add_class("active")
        self.query_one("#tab-plans").remove_class("active")

    def _switch_to_plans(self) -> None:
        self._active_tab = "plans"
        self.query_one("#files-panel").display = False
        self.query_one("#plans-panel").display = True
        self.query_one("#tab-files").remove_class("active")
        self.query_one("#tab-plans").add_class("active")

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

    def _load_plan(self, plan_path: str) -> None:
        slug = os.path.basename(plan_path).replace(".md", "")
        self.sub_title = slug
        content = read_plan(plan_path)
        self.query_one("#plan-markdown", Markdown).update(content)

    def on_list_view_highlighted(self, event: ListView.Highlighted) -> None:
        item = event.item
        if isinstance(item, FileListItem):
            self._load_diff(item.file_path)
        elif isinstance(item, PlanListItem):
            self._load_plan(item.plan_path)

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        item = event.item
        if isinstance(item, FileListItem):
            self._load_diff(item.file_path)
        elif isinstance(item, PlanListItem):
            self._load_plan(item.plan_path)

    def action_refresh(self) -> None:
        if self._active_tab == "files":
            self.run_worker(self.refresh_files(), exclusive=True)
        else:
            self.run_worker(self.refresh_plans(), exclusive=True)

    def _update_preview_for_current(self) -> None:
        """Load the diff/plan for the currently highlighted list item."""
        if self._active_tab == "files":
            lv = self.query_one("#file-list", ListView)
            item = lv.highlighted_child
            if isinstance(item, FileListItem):
                self._load_diff(item.file_path)
        else:
            lv = self.query_one("#plan-list", ListView)
            item = lv.highlighted_child
            if isinstance(item, PlanListItem):
                self._load_plan(item.plan_path)

    def action_cursor_down(self) -> None:
        if self._active_tab == "files":
            self.query_one("#file-list", ListView).action_cursor_down()
        else:
            self.query_one("#plan-list", ListView).action_cursor_down()
        self._update_preview_for_current()

    def action_cursor_up(self) -> None:
        if self._active_tab == "files":
            self.query_one("#file-list", ListView).action_cursor_up()
        else:
            self.query_one("#plan-list", ListView).action_cursor_up()
        self._update_preview_for_current()

    def action_show_files(self) -> None:
        self._switch_to_files()

    def action_show_plans(self) -> None:
        self.run_worker(self.refresh_plans(), exclusive=True)
        self._switch_to_plans()


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
