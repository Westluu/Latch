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
from typing import Optional, Tuple

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
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
        self._icon = Static(">", classes="project-icon")
        self._alias = Static(project.alias, classes="project-alias")
        self._path = Static(shorten_path(project.path, 68), classes="project-path")
        self._content = Vertical(self._alias, self._path, classes="project-content")
        self._row = Horizontal(self._icon, self._content, classes="project-row")

    def compose(self) -> ComposeResult:
        yield self._row

    def set_selected(self, selected: bool) -> None:
        self._row.set_class(selected, "-selected")


class DirectorySuggestionItem(ListItem):
    def __init__(self, path: str) -> None:
        super().__init__()
        self.path = path
        name = os.path.basename(path.rstrip(os.sep)) or path
        parent = shorten_path(os.path.dirname(path), 24)
        label = f"[bold #E5E7EB]{name}/[/] [#64748B]{parent}[/]"
        self._row = Static(label, classes="directory-row")

    def compose(self) -> ComposeResult:
        yield self._row

    def set_selected(self, selected: bool) -> None:
        self._row.set_class(selected, "-selected")


class AddWorkspaceModal(ModalScreen[Optional[Tuple[str, str]]]):
    CSS = """
    AddWorkspaceModal {
        align: center middle;
        background: rgba(3, 7, 18, 0.72);
    }

    #add-modal {
        width: 84;
        min-width: 60;
        max-width: 96%;
        height: auto;
        background: #0F172A;
        padding: 0;
    }

    .main-panel {
        border: round #4B5563;
        background: #111827;
        padding: 1 2;
    }

    #details-panel {
        height: auto;
    }

    #preview-panel {
        height: auto;
        min-height: 8;
        margin: 1 0 0 0;
    }

    #actions-row {
        align: center middle;
        height: 3;
    }

    .panel-title {
        color: #CBD5E1;
        text-style: bold;
        padding: 0 0 1 0;
    }

    .field-row {
        height: auto;
        margin: 0 0 1 0;
        align: left top;
    }

    .field-label {
        width: 16;
        min-width: 16;
        color: #94A3B8;
        padding: 1 1 0 0;
    }

    .field-input {
        width: 1fr;
        min-width: 0;
    }

    .field-stack {
        width: 1fr;
        min-width: 0;
    }

    #modal-alias,
    #modal-path {
        margin: 0;
    }

    #matches-panel {
        width: 1fr;
        min-width: 0;
        height: auto;
        margin: 1 0 0 0;
        border: round #334155;
        background: #0B1220;
        padding: 0 1;
    }

    #matches-title {
        color: #94A3B8;
        padding: 0 0 1 0;
    }

    #matches-list {
        height: 5;
        padding: 0;
        border: none;
        background: transparent;
    }

    ListView > ListItem {
        padding: 0;
        background: transparent;
        width: 1fr;
    }

    .directory-row {
        width: 1fr;
        padding: 0 1;
        color: #94A3B8;
    }

    .directory-row.-selected {
        background: #374151;
        color: #F8FAFC;
    }

    #preview-title {
        color: #CBD5E1;
        text-style: bold;
        padding: 0 0 1 0;
    }

    #preview-content {
        color: #94A3B8;
    }

    .action-button {
        width: auto;
        min-width: 18;
        color: #E2E8F0;
        background: #243041;
        border: tall #4B5563;
        content-align: center middle;
        padding: 0 2;
        margin: 0 1 0 0;
    }

    .action-button.-primary {
        background: #334155;
        border: tall #64748B;
    }
    """

    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
        Binding("tab", "tab_next", "Next Match", show=False, priority=True),
        Binding("shift+tab", "tab_prev", "Prev Match", show=False, priority=True),
        Binding("down", "next_match", show=False, priority=True),
        Binding("up", "prev_match", show=False, priority=True),
        Binding("ctrl+j", "next_match", show=False),
        Binding("ctrl+k", "prev_match", show=False),
    ]

    def __init__(self, cwd: str) -> None:
        super().__init__()
        self.cwd = cwd
        self._suggestion_paths: list[str] = []
        self._suggestion_items: list[DirectorySuggestionItem] = []

    def compose(self) -> ComposeResult:
        with Vertical(id="add-modal"):
            with Vertical(id="details-panel", classes="main-panel"):
                yield Static("PROJECT DETAILS", classes="panel-title")
                with Horizontal(classes="field-row"):
                    yield Static("Project Name:", classes="field-label")
                    yield Input(placeholder="Alias", id="modal-alias", classes="field-input")
                with Horizontal(classes="field-row"):
                    yield Static("Project Path:", classes="field-label")
                    with Vertical(classes="field-stack"):
                        yield Input(value=self.cwd, placeholder="Path", id="modal-path", classes="field-input")
                        with Vertical(id="matches-panel"):
                            yield Static("MATCHES (TAB TO NAVIGATE)", id="matches-title")
                            yield ListView(id="matches-list")
            with Vertical(id="preview-panel", classes="main-panel"):
                yield Static("PATH PREVIEW", id="preview-title")
                yield Static("", id="preview-path")
                yield Static("", id="preview-content")
            with Horizontal(id="actions-row"):
                yield Static("[ CREATE PROJECT ]", classes="action-button -primary")
                yield Static("[ CANCEL ]", classes="action-button")

    def on_mount(self) -> None:
        self._refresh_matches()
        self.query_one("#modal-alias", Input).focus()

    def action_cancel(self) -> None:
        self.dismiss(None)

    def _display_path(self, path: str) -> str:
        home = os.path.expanduser("~")
        return path.replace(home, "~", 1) if path.startswith(home) else path

    def _resolve_input_path(self) -> str:
        raw = self.query_one("#modal-path", Input).value.strip()
        if not raw:
            return self.cwd
        expanded = os.path.expanduser(raw)
        if not os.path.isabs(expanded):
            expanded = os.path.join(self.cwd, expanded)
        return os.path.abspath(expanded)

    def _selected_suggestion_path(self) -> Optional[str]:
        list_view = self.query_one("#matches-list", ListView)
        if not self._suggestion_paths:
            return None
        index = list_view.index or 0
        if index < 0 or index >= len(self._suggestion_paths):
            return None
        return self._suggestion_paths[index]

    def _set_selected_suggestion(self, index: Optional[int]) -> None:
        for item_index, item in enumerate(self._suggestion_items):
            item.set_selected(index is not None and item_index == index)

    def _apply_selected_suggestion(self) -> bool:
        selected_path = self._selected_suggestion_path()
        if selected_path is None:
            return False

        path_input = self.query_one("#modal-path", Input)
        current_resolved = self._resolve_input_path()

        if os.path.normpath(current_resolved) == os.path.normpath(selected_path):
            return False

        path_input.value = self._display_path(selected_path)
        path_input.focus()
        self._refresh_matches()
        return True

    def _directory_matches(self) -> list[str]:
        raw = self.query_one("#modal-path", Input).value
        resolved = self._resolve_input_path()
        typed = raw.strip()
        if typed.endswith(os.sep):
            base_dir = resolved
            fragment = ""
        else:
            base_dir = os.path.dirname(resolved) or os.sep
            fragment = os.path.basename(resolved)

        if not os.path.isdir(base_dir):
            return []

        matches: list[str] = []
        try:
            with os.scandir(base_dir) as entries:
                for entry in entries:
                    if not entry.is_dir():
                        continue
                    if fragment and not entry.name.lower().startswith(fragment.lower()):
                        continue
                    matches.append(os.path.join(base_dir, entry.name))
        except OSError:
            return []

        matches.sort(key=lambda path: os.path.basename(path).lower())
        return matches[:8]

    def _preview_lines(self, path: str) -> str:
        if not os.path.isdir(path):
            return "Directory not found yet."

        lines: list[str] = []
        try:
            entries = sorted(os.scandir(path), key=lambda entry: (not entry.is_dir(), entry.name.lower()))
            for entry in entries[:8]:
                suffix = "/" if entry.is_dir() else ""
                lines.append(f"{entry.name}{suffix}")
        except OSError as error:
            return f"Could not read directory: {error}"

        if not lines:
            return "(empty directory)"
        return "\n".join(lines)

    def _preview_target(self) -> str:
        resolved = self._resolve_input_path()
        if os.path.isdir(resolved):
            return resolved
        return self._selected_suggestion_path() or resolved

    def _submission_path(self) -> str:
        resolved = self._resolve_input_path()
        if os.path.isdir(resolved):
            return resolved
        return self._selected_suggestion_path() or self.query_one("#modal-path", Input).value.strip() or self.cwd

    def _refresh_preview(self) -> None:
        target = self._preview_target()
        display_path = shorten_path(self._display_path(target), 54)
        self.query_one("#preview-title", Static).update(f"PATH PREVIEW: {display_path}")
        self.query_one("#preview-path", Static).update("")
        self.query_one("#preview-content", Static).update(self._preview_lines(target))

    def _refresh_matches(self) -> None:
        list_view = self.query_one("#matches-list", ListView)
        list_view.clear()
        self._suggestion_items = []
        self._suggestion_paths = self._directory_matches()

        for path in self._suggestion_paths:
            item = DirectorySuggestionItem(path)
            self._suggestion_items.append(item)
            list_view.append(item)

        if self._suggestion_paths:
            list_view.index = 0
            self._set_selected_suggestion(0)
        else:
            self._set_selected_suggestion(None)

        self._refresh_preview()

    def action_tab_next(self) -> None:
        if self.focused is self.query_one("#modal-alias", Input):
            self.query_one("#modal-path", Input).focus()
            return
        self.action_next_match()

    def action_tab_prev(self) -> None:
        if self.focused is self.query_one("#modal-path", Input):
            self.query_one("#modal-alias", Input).focus()
            return
        self.action_prev_match()

    def action_next_match(self) -> None:
        if not self._suggestion_paths:
            return
        list_view = self.query_one("#matches-list", ListView)
        current_index = list_view.index or 0
        next_index = (current_index + 1) % len(self._suggestion_paths)
        list_view.index = next_index
        self._set_selected_suggestion(next_index)
        self._refresh_preview()

    def action_prev_match(self) -> None:
        if not self._suggestion_paths:
            return
        list_view = self.query_one("#matches-list", ListView)
        current_index = list_view.index or 0
        next_index = (current_index - 1) % len(self._suggestion_paths)
        list_view.index = next_index
        self._set_selected_suggestion(next_index)
        self._refresh_preview()

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id == "modal-path":
            self._refresh_matches()

    def on_list_view_highlighted(self, event: ListView.Highlighted) -> None:
        if event.list_view.id != "matches-list":
            return
        self._set_selected_suggestion(event.list_view.index)
        self._refresh_preview()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "modal-alias":
            alias = event.value.strip()
            if not alias:
                return
            self.query_one("#modal-path", Input).focus()
            return

        if self._apply_selected_suggestion():
            return

        alias = self.query_one("#modal-alias", Input).value.strip()
        path = self._submission_path()
        if not alias:
            self.query_one("#modal-alias", Input).focus()
            return
        self.dismiss((alias, path))


CSS = """
Screen {
    background: #111827;
}

#search-input {
    margin: 0 0 1 0;
}

#projects-list {
    border: round #4B5563;
    padding: 1;
    background: #0B1220;
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
    height: auto;
    margin: 0 0 1 0;
}

.project-row {
    width: 1fr;
    height: auto;
    min-height: 3;
    padding: 0 1 1 1;
    background: transparent;
    align: left top;
}

.project-row.-selected {
    background: #172033;
    border-left: wide #7C3AED;
    padding: 1 1 1 1;
}

.project-icon {
    width: 3;
    padding: 0 0 0 0;
    color: #475569;
    text-style: bold;
}

.project-row.-selected .project-icon {
    color: #A78BFA;
}

.project-content {
    width: 1fr;
    height: auto;
    padding: 0;
}

.project-alias {
    color: #E5E7EB;
    text-style: bold;
    padding: 0;
    height: auto;
}

.project-path {
    color: #94A3B8;
    padding: 0;
    height: auto;
}

.project-row.-selected .project-alias {
    color: #F8FAFC;
}

.project-row.-selected .project-path {
    color: #CBD5E1;
}
"""


class ProjectsApp(App):
    CSS = CSS

    BINDINGS = [
        Binding("escape", "close_or_cancel", "Close"),
        Binding("q", "quit", "Quit"),
        Binding("j,down", "cursor_down", "Down"),
        Binding("k,up", "cursor_up", "Up"),
        Binding("enter", "open_selected", "Open"),
        Binding("ctrl+t,t", "open_selected_in_tab", "Open in Tab", show=False, priority=True),
        Binding("slash", "focus_search", "Search", show=False),
        Binding("a", "start_add", "Add"),
        Binding("d", "delete_selected", "Delete"),
        Binding("r", "refresh", "Refresh"),
    ]

    def __init__(self, cwd: str) -> None:
        super().__init__()
        self.cwd = cwd
        self._projects: list[ProjectInfo] = []
        self._filtered_projects: list[ProjectInfo] = []
        self._items: list[ProjectListItem] = []
        self._pending_delete_alias: str | None = None

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
        if self._projects:
            self.query_one("#projects-list", ListView).focus()
        else:
            self.query_one("#search-input", Input).focus()

    def _refresh_projects(self) -> None:
        try:
            self._projects = load_projects()
            self._sync_project_list(clear_status=True)
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
            empty.update("No saved projects yet. Press `a` to add one.")
        else:
            empty.update("")

        if self._filtered_projects:
            list_view.index = 0
            self._set_selected_index(0)
        else:
            self._set_selected_index(None)

    def _set_selected_index(self, index: int | None) -> None:
        for item_index, item in enumerate(self._items):
            item.set_selected(index is not None and item_index == index)

    def _select_project_alias(self, alias: str) -> None:
        if not self._filtered_projects:
            self._set_selected_index(None)
            return

        list_view = self.query_one("#projects-list", ListView)
        for index, project in enumerate(self._filtered_projects):
            if project.alias == alias:
                list_view.index = index
                self._set_selected_index(index)
                return

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

    def _cli_path(self) -> str:
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        return os.path.join(repo_root, "dist", "cli.js")

    def _run_cli(self, args: list[str]) -> subprocess.CompletedProcess[str] | None:
        cli_path = self._cli_path()
        if not os.path.exists(cli_path):
            self._set_status("dist/cli.js not found. Run `npm run build` first.")
            return None

        return subprocess.run(
            ["node", cli_path, *args],
            cwd=self.cwd,
            capture_output=True,
            text=True,
        )

    def _apply_search_filter(self) -> None:
        query = self.query_one("#search-input", Input).value.strip().lower()
        if not query:
            self._filtered_projects = self._projects
            return

        self._filtered_projects = [
            project for project in self._projects
            if query in project.alias.lower() or query in project.path.lower()
        ]

    def _sync_project_list(
        self,
        *,
        select_alias: Optional[str] = None,
        clear_status: bool = False,
    ) -> None:
        self._apply_search_filter()
        self._render_projects()
        if select_alias is not None:
            self._select_project_alias(select_alias)
        if clear_status:
            self._set_status("")

    def _clear_delete_confirmation(self) -> None:
        self._pending_delete_alias = None

    def _after_add_modal(self, result: Optional[Tuple[str, str]]) -> None:
        self.query_one("#projects-list", ListView).focus()
        if result is None:
            self._set_status("Add canceled.")
            return

        alias, path = result
        self._submit_add(alias, path)

    def action_close_or_cancel(self) -> None:
        if self._pending_delete_alias is not None:
            self._pending_delete_alias = None
            self._set_status("Delete canceled.")
            return

        self.exit()

    def action_focus_search(self) -> None:
        self.query_one("#search-input", Input).focus()

    def action_start_add(self) -> None:
        self._clear_delete_confirmation()
        self.push_screen(AddWorkspaceModal(self.cwd), self._after_add_modal)

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id != "search-input":
            return

        self._clear_delete_confirmation()
        self._sync_project_list(clear_status=True)

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "search-input":
            self.action_open_selected()

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        if event.list_view.id == "projects-list":
            self.action_open_selected()

    def on_list_view_highlighted(self, event: ListView.Highlighted) -> None:
        if event.list_view.id != "projects-list":
            return
        self._clear_delete_confirmation()
        self._set_selected_index(event.list_view.index)

    def action_cursor_down(self) -> None:
        if self._filtered_projects:
            self.query_one("#projects-list", ListView).action_cursor_down()

    def action_cursor_up(self) -> None:
        if self._filtered_projects:
            self.query_one("#projects-list", ListView).action_cursor_up()

    def action_refresh(self) -> None:
        self._clear_delete_confirmation()
        self._refresh_projects()

    def _submit_add(self, alias: str, path: str) -> None:
        if not alias:
            self._set_status("Alias is required.")
            return

        result = self._run_cli(["project", "add", path, alias])
        if result is None:
            return
        if result.returncode != 0:
            self._set_status(result.stderr.strip() or result.stdout.strip() or "Could not add project.")
            return

        self._refresh_projects()
        search_input = self.query_one("#search-input", Input)
        search_input.value = ""
        self._sync_project_list(select_alias=alias)
        self.query_one("#projects-list", ListView).focus()
        self._set_status(result.stdout.strip() or f'Saved project "{alias}".')

    def action_delete_selected(self) -> None:
        project = self._selected_project()
        if not project:
            self._set_status("No project selected.")
            return

        if self._pending_delete_alias != project.alias:
            self._pending_delete_alias = project.alias
            self._set_status(f'Press `d` again to delete "{project.alias}".')
            return

        result = self._run_cli(["project", "remove", project.alias])
        self._pending_delete_alias = None
        if result is None:
            return
        if result.returncode != 0:
            self._set_status(result.stderr.strip() or result.stdout.strip() or "Could not remove project.")
            return

        self._refresh_projects()
        self._set_status(result.stdout.strip() or f'Removed project "{project.alias}".')

    def action_open_selected(self) -> None:
        project = self._selected_project()
        if not project:
            return

        result = self._run_cli(["project", "open", project.alias, "--current-session"])
        if result is None:
            return
        if result.returncode != 0:
            self._set_status(result.stderr.strip() or result.stdout.strip() or "Could not open project.")
            return
        self.exit()

    def action_open_selected_in_tab(self) -> None:
        project = self._selected_project()
        if not project:
            return

        result = self._run_cli(["project", "open", project.alias, "--tab"])
        if result is None:
            return
        if result.returncode != 0:
            self._set_status(result.stderr.strip() or result.stdout.strip() or "Could not open project in a new tab.")
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
