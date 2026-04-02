"""
Latch sidecar TUI — file list + diff viewer + plans viewer.

Usage:
    python3 ui/sidecar.py <cwd> [session_id]
"""

from __future__ import annotations

import asyncio
import os
import sys
from typing import Optional

try:
    from ._runtime import arg_value, bootstrap_python_root, register_socket_cleanup, require_directory_arg
except ImportError:
    from _runtime import arg_value, bootstrap_python_root, register_socket_cleanup, require_directory_arg

bootstrap_python_root()

from latch import theme
from latch.git_state import STATUS_COLORS, get_changed_files, get_diff, render_diff
from latch.ipc import build_socket_path, cleanup_socket, start_ipc_server
from latch.session_store import get_session_plan_path, read_plan
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, VerticalScroll
from textual.widgets import Footer, Header, ListItem, ListView, Markdown, Static


# ── Custom ListItem widgets ───────────────────────────────────────────────────


class FileListItem(ListItem):
    def __init__(self, file_path: str, status: str, label: str, max_width: int = 20) -> None:
        self.file_path = file_path
        color = STATUS_COLORS.get(status, theme.TEXT_SUBTLE)
        name = os.path.basename(file_path)
        display = name if len(name) <= 10 else name[:6] + "…"
        markup = f"[bold {color}]{label}[/]  {display}"
        super().__init__(Static(markup))


class PlanListItem(ListItem):
    def __init__(self, plan_path: str) -> None:
        self.plan_path = plan_path
        slug = os.path.basename(plan_path).replace(".md", "")
        display = slug if len(slug) <= 24 else slug[:21] + "…"
        markup = f"[{theme.ACCENT_SOFT}]▸[/] {display}"
        super().__init__(Static(markup))


# ── Main App ──────────────────────────────────────────────────────────────────

CSS = """
Screen {
    background: %(app_bg)s;
}

#tab-bar {
    height: 1;
    background: %(surface_bg)s;
}

#tab-files {
    width: 50%%;
    content-align: center middle;
    background: %(surface_bg)s;
    color: %(text_subtle)s;
}

#tab-files.active {
    background: %(accent)s;
    color: %(text_bright)s;
}

#tab-plans {
    width: 50%%;
    content-align: center middle;
    background: %(surface_bg)s;
    color: %(text_subtle)s;
}

#tab-plans.active {
    background: %(accent)s;
    color: %(text_bright)s;
}

#files-panel {
    display: block;
}

#plans-panel {
    display: none;
}

#file-list {
    width: 28%%;
    border: round %(border)s;
    padding: 0 1;
}

#file-list:focus-within {
    border: round %(border_focus)s;
}

#diff-view {
    width: 72%%;
    border: round %(border)s;
    overflow-y: scroll;
}

#diff-view:focus-within {
    border: round %(border_focus)s;
}

#plan-list {
    width: 28%%;
    border: round %(border)s;
    padding: 0 1;
}

#plan-list:focus-within {
    border: round %(border_focus)s;
}

#plan-view {
    width: 72%%;
    border: round %(border)s;
    overflow-y: scroll;
    padding: 0 1;
}

#plan-view:focus-within {
    border: round %(border_focus)s;
}

#plan-view Markdown {
    background: transparent;
}

#plan-empty {
    color: %(text_faint)s;
    padding: 1 2;
}

ListView > ListItem {
    padding: 0 1;
    background: transparent;
}

ListView > ListItem.--highlight {
    background: %(selection_bg)s;
}
""" % {
    "accent": theme.ACCENT,
    "app_bg": theme.APP_BG,
    "border": theme.BORDER,
    "border_focus": theme.BORDER_FOCUS,
    "selection_bg": theme.SELECTION_BG,
    "surface_bg": theme.SURFACE_BG,
    "text_bright": theme.TEXT_BRIGHT,
    "text_faint": theme.TEXT_FAINT,
    "text_subtle": theme.TEXT_SUBTLE,
}


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
        self._socket_path = build_socket_path(cwd, "sidecar", session_id)

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
        except asyncio.CancelledError:
            raise
        except OSError:
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
    cwd = require_directory_arg(sys.argv, 1, "Usage: python3 ui/sidecar.py <cwd> [session_id]")
    session_id = arg_value(sys.argv, 2)

    socket_path = build_socket_path(cwd, "sidecar", session_id)
    register_socket_cleanup(socket_path, cleanup_socket)

    app = SidecarApp(cwd, session_id)
    app.run()
