"""
Latch workspaces picker TUI.

Launched either in a left tmux pane or via `tmux display-popup`.

Usage:
    python3 projects.py <cwd>
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.widgets import Footer, Header, Input, ListItem, ListView, Static


@dataclass
class ProjectInfo:
    alias: str
    path: str
    created_at: str
    updated_at: str
    last_opened_at: str | None


def get_projects_config_path() -> str:
    base_dir = os.environ.get("XDG_CONFIG_HOME")
    if base_dir:
        return os.path.join(os.path.abspath(base_dir), "latch", "projects.json")
    return os.path.join(os.path.expanduser("~"), ".config", "latch", "projects.json")


def load_projects() -> list[ProjectInfo]:
    config_path = get_projects_config_path()
    if not os.path.exists(config_path):
        return []

    with open(config_path) as f:
        data = json.load(f)

    projects = data.get("projects", {})
    items: list[ProjectInfo] = []
    for alias, project in projects.items():
        items.append(
            ProjectInfo(
                alias=alias,
                path=project["path"],
                created_at=project["createdAt"],
                updated_at=project["updatedAt"],
                last_opened_at=project["lastOpenedAt"],
            )
        )
    items.sort(key=lambda project: project.alias.lower())
    return items


def shorten_path(path: str, max_len: int = 52) -> str:
    home = os.path.expanduser("~")
    display = path.replace(home, "~", 1) if path.startswith(home) else path
    if len(display) <= max_len:
        return display
    return "..." + display[-(max_len - 3):]


class ProjectListItem(ListItem):
    def __init__(self, project: ProjectInfo) -> None:
        super().__init__()
        self.project = project
        label = f"[bold #E5E7EB]{project.alias:<16}[/] [#9CA3AF]{shorten_path(project.path)}[/]"
        self._row = Static(label, classes="project-row")

    def compose(self) -> ComposeResult:
        yield self._row

    def set_selected(self, selected: bool) -> None:
        self._row.set_class(selected, "-selected")


CSS = """
Screen {
    background: #111827;
}

#search-input {
    margin: 0 0 1 0;
}

#projects-list {
    border: round #4B5563;
    padding: 0 1;
}

#projects-list:focus-within {
    border: round #7C3AED;
}

#empty-state {
    color: #6B7280;
    padding: 1 2;
}

#status {
    color: #FCA5A5;
    padding: 1 2 0 2;
}

ListView > ListItem {
    padding: 0;
    background: transparent;
    width: 1fr;
}

.project-row {
    width: 1fr;
    padding: 0 1;
    background: transparent;
    color: #9CA3AF;
}

.project-row.-selected {
    background: #4B5563;
    color: #F9FAFB;
}
"""


class ProjectsApp(App):
    CSS = CSS

    BINDINGS = [
        Binding("escape", "quit", "Close"),
        Binding("q", "quit", "Close"),
        Binding("j,down", "cursor_down", "Down"),
        Binding("k,up", "cursor_up", "Up"),
        Binding("enter", "open_selected", "Open"),
        Binding("slash", "focus_search", "Search", show=False),
        Binding("r", "refresh", "Refresh"),
    ]

    def __init__(self, cwd: str) -> None:
        super().__init__()
        self.cwd = cwd
        self._projects: list[ProjectInfo] = []
        self._filtered_projects: list[ProjectInfo] = []
        self._items: list[ProjectListItem] = []

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Vertical():
            yield Input(placeholder="Search projects…", id="search-input")
            yield ListView(id="projects-list")
            yield Static("", id="empty-state")
            yield Static("", id="status")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "LATCH / WORKSPACES"
        self._refresh_projects()
        self.query_one("#search-input", Input).focus()

    def _refresh_projects(self) -> None:
        try:
            self._projects = load_projects()
            self._filtered_projects = self._projects
            self._render_projects()
            self._set_status("")
        except Exception as error:
            self._projects = []
            self._filtered_projects = []
            self._render_projects()
            self._set_status(f"Could not load projects: {error}")

    def _render_projects(self) -> None:
        list_view = self.query_one("#projects-list", ListView)
        list_view.clear()
        self._items = []

        for project in self._filtered_projects:
            item = ProjectListItem(project)
            self._items.append(item)
            list_view.append(item)

        empty = self.query_one("#empty-state", Static)
        if self._projects and not self._filtered_projects:
            empty.update("No projects match the current search.")
        elif not self._projects:
            empty.update("No saved projects yet. Add one with `latch project add --current <name>`.")
        else:
            empty.update("")

        if self._filtered_projects:
            list_view.index = 0
            self._set_selected_index(0)

    def _set_selected_index(self, index: int | None) -> None:
        for item_index, item in enumerate(self._items):
            item.set_selected(index is not None and item_index == index)

    def _set_status(self, message: str) -> None:
        self.query_one("#status", Static).update(message)

    def _selected_project(self) -> ProjectInfo | None:
        list_view = self.query_one("#projects-list", ListView)
        if not self._filtered_projects:
            return None
        index = list_view.index or 0
        if index < 0 or index >= len(self._filtered_projects):
            return None
        return self._filtered_projects[index]

    def action_focus_search(self) -> None:
        self.query_one("#search-input", Input).focus()

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id != "search-input":
            return

        query = event.value.strip().lower()
        if not query:
            self._filtered_projects = self._projects
        else:
            self._filtered_projects = [
                project for project in self._projects
                if query in project.alias.lower() or query in project.path.lower()
            ]
        self._render_projects()
        self._set_status("")

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "search-input":
            self.action_open_selected()

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        if event.list_view.id == "projects-list":
            self.action_open_selected()

    def on_list_view_highlighted(self, event: ListView.Highlighted) -> None:
        if event.list_view.id != "projects-list":
            return
        self._set_selected_index(event.list_view.index)

    def action_cursor_down(self) -> None:
        if self._filtered_projects:
            self.query_one("#projects-list", ListView).action_cursor_down()

    def action_cursor_up(self) -> None:
        if self._filtered_projects:
            self.query_one("#projects-list", ListView).action_cursor_up()

    def action_refresh(self) -> None:
        self._refresh_projects()

    def action_open_selected(self) -> None:
        project = self._selected_project()
        if not project:
            return

        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        cli_path = os.path.join(repo_root, "dist", "cli.js")

        if not os.path.exists(cli_path):
            self._set_status("dist/cli.js not found. Run `npm run build` first.")
            return

        result = subprocess.run(
            ["node", cli_path, "project", "open", project.alias, "--popup"],
            cwd=self.cwd,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            self._set_status(result.stderr.strip() or result.stdout.strip() or "Could not open project.")
            return
        self.exit()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 projects.py <cwd>", file=sys.stderr)
        sys.exit(1)

    cwd = os.path.abspath(sys.argv[1])
    if not os.path.isdir(cwd):
        print(f"Error: {cwd!r} is not a directory", file=sys.stderr)
        sys.exit(1)

    app = ProjectsApp(cwd)
    app.run()
