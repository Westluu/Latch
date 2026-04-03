"""
Latch workspaces picker TUI.

Launched either in a left tmux pane or via `tmux display-popup`.

Usage:
    python3 ui/projects.py <cwd>
"""

from __future__ import annotations

import os
import subprocess
from typing import Optional, Sequence, Tuple, TypeVar

try:
    from ._runtime import bootstrap_python_root, dist_cli_path, require_directory_arg
except ImportError:
    from _runtime import bootstrap_python_root, dist_cli_path, require_directory_arg

bootstrap_python_root()

from latch.projects_store import ProjectInfo, WorkspaceInfo, load_projects
from textual.actions import SkipAction
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.widgets import Footer, Header, Input, ListItem, ListView, Rule, Static

try:
    from .projects_modal import AddWorkspaceModal, AddWorktreeModal
    from .projects_widgets import PROJECTS_LIST_CSS, ProjectListItem, WorkspaceListItem
except ImportError:
    from projects_modal import AddWorkspaceModal, AddWorktreeModal
    from projects_widgets import PROJECTS_LIST_CSS, ProjectListItem, WorkspaceListItem

T = TypeVar("T")


class ProjectsApp(App):
    CSS = PROJECTS_LIST_CSS

    BINDINGS = [
        Binding("escape", "close_or_cancel", "Close"),
        Binding("a", "start_add", "Add"),
        Binding("q", "quit", "Quit"),
        Binding("d", "delete_selected", "Delete"),
        Binding("enter", "open_selected", "Open"),
        Binding("ctrl+t,t", "open_selected_in_tab", "Open in Tab", show=False, priority=True),
        Binding("right,l", "view_workspaces", "Workspaces", show=False, priority=True),
        Binding("left,h,backspace", "back", "Back", show=False, priority=True),
        Binding("slash", "focus_search", "Search", show=False),
        Binding("j,down", "cursor_down", "Down"),
        Binding("k,up", "cursor_up", "Up"),
        Binding("r", "refresh", "Refresh", show=False),
    ]

    def __init__(self, cwd: str) -> None:
        super().__init__()
        self.cwd = cwd
        self._projects: list[ProjectInfo] = []
        self._filtered_projects: list[ProjectInfo] = []
        self._workspaces: list[WorkspaceInfo] = []
        self._filtered_workspaces: list[WorkspaceInfo] = []
        self._items: list[ListItem] = []
        self._pending_delete_alias: str | None = None
        self._mode = "projects"
        self._active_project_alias: str | None = None

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        yield Rule(id="header-rule")
        with Horizontal(id="search-bar"):
            yield Static("○", id="search-icon")
            yield Input(placeholder="Search projects…", id="search-input")
        yield ListView(id="projects-list")
        yield Static("", id="empty-state")
        yield Static("", id="status")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "LATCH / WORKSPACES"
        self._update_subtitle()
        self._refresh_projects()
        if self._projects:
            self.query_one("#projects-list", ListView).focus()
        else:
            self.query_one("#search-input", Input).focus()

    def _update_subtitle(self) -> None:
        if self._mode == "workspaces":
            alias = self._active_project_alias or "Project"
            self.sub_title = f"{alias} / Workspaces"
        else:
            self.sub_title = "Projects"

    def _active_project(self) -> ProjectInfo | None:
        if self._active_project_alias is None:
            return None
        for project in self._projects:
            if project.alias == self._active_project_alias:
                return project
        return None

    def _refresh_projects(self) -> None:
        try:
            self._projects = load_projects()
            if self._mode == "workspaces":
                active_project = self._active_project()
                if active_project is None:
                    self._mode = "projects"
                    self._active_project_alias = None
                    self._workspaces = []
                    self._filtered_workspaces = []
                else:
                    self._workspaces = active_project.workspaces
            self._sync_list(clear_status=True)
        except (OSError, ValueError, TypeError, KeyError) as error:
            self._projects = []
            self._filtered_projects = []
            self._workspaces = []
            self._filtered_workspaces = []
            self._render_current_list()
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

    def _render_workspaces(self) -> None:
        list_view = self.query_one("#projects-list", ListView)
        list_view.clear()
        self._items = []

        for workspace in self._filtered_workspaces:
            item = WorkspaceListItem(workspace)
            self._items.append(item)
            list_view.append(item)

        empty = self.query_one("#empty-state", Static)
        active_project = self._active_project()
        if self._workspaces and not self._filtered_workspaces:
            empty.update("No workspaces match the current search.")
        elif active_project is not None and not self._workspaces:
            empty.update(f'No workspaces for "{active_project.alias}" yet.')
        else:
            empty.update("")

        if self._filtered_workspaces:
            list_view.index = 0
            self._set_selected_index(0)
        else:
            self._set_selected_index(None)

    def _render_current_list(self) -> None:
        self._update_subtitle()
        if self._mode == "workspaces":
            self._render_workspaces()
        else:
            self._render_projects()

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

    def _select_workspace_name(self, workspace_name: str) -> None:
        if not self._filtered_workspaces:
            self._set_selected_index(None)
            return

        list_view = self.query_one("#projects-list", ListView)
        for index, workspace in enumerate(self._filtered_workspaces):
            if workspace.name == workspace_name:
                list_view.index = index
                self._set_selected_index(index)
                return

    def _set_status(self, message: str) -> None:
        self.query_one("#status", Static).update(message)

    def _selected_item(self, items: Sequence[T]) -> T | None:
        if not items:
            return None
        index = self.query_one("#projects-list", ListView).index or 0
        return items[index] if 0 <= index < len(items) else None

    def _selected_project(self) -> ProjectInfo | None:
        return self._selected_item(self._filtered_projects) if self._mode == "projects" else None

    def _selected_workspace(self) -> WorkspaceInfo | None:
        return self._selected_item(self._filtered_workspaces) if self._mode == "workspaces" else None

    def _cli_path(self) -> str:
        return dist_cli_path()

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
        if self._mode == "workspaces":
            if not query:
                self._filtered_workspaces = self._workspaces
                return

            self._filtered_workspaces = [
                workspace for workspace in self._workspaces
                if query in workspace.name.lower()
                or query in workspace.path.lower()
                or query in workspace.kind.lower()
                or (workspace.branch is not None and query in workspace.branch.lower())
            ]
            return

        if not query:
            self._filtered_projects = self._projects
            return

        self._filtered_projects = [
            project for project in self._projects
            if query in project.alias.lower() or query in project.root_path.lower()
        ]

    def _sync_list(
        self,
        *,
        select_alias: Optional[str] = None,
        select_workspace: Optional[str] = None,
        clear_status: bool = False,
    ) -> None:
        self._apply_search_filter()
        self._render_current_list()
        if self._mode == "projects" and select_alias is not None:
            self._select_project_alias(select_alias)
        if self._mode == "workspaces" and select_workspace is not None:
            self._select_workspace_name(select_workspace)
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

    def _after_add_worktree_modal(self, result: Optional[Tuple[str, str]]) -> None:
        self.query_one("#projects-list", ListView).focus()
        if result is None:
            self._set_status("Add canceled.")
            return

        project = self._active_project()
        if project is None:
            self._set_status("Could not determine the active project.")
            return

        workspace_name, copy_from = result
        self._submit_add_worktree(project.alias, workspace_name, copy_from)

    def action_close_or_cancel(self) -> None:
        if self._pending_delete_alias is not None:
            self._pending_delete_alias = None
            self._set_status("Delete canceled.")
            return

        if self._mode == "workspaces":
            self.action_back()
            return

        self.exit()

    def _skip_if_modal_open(self) -> None:
        if self.screen.is_modal:
            raise SkipAction()

    def action_back(self) -> None:
        self._skip_if_modal_open()
        if self._mode != "workspaces":
            self.exit()
            return

        active_alias = self._active_project_alias
        self._mode = "projects"
        self._active_project_alias = None
        self._workspaces = []
        self._filtered_workspaces = []
        self._sync_list(select_alias=active_alias, clear_status=True)
        self.query_one("#projects-list", ListView).focus()

    def action_focus_search(self) -> None:
        self.query_one("#search-input", Input).focus()

    def action_start_add(self) -> None:
        self._clear_delete_confirmation()
        if self._mode == "workspaces":
            project = self._active_project()
            if project is None:
                self._set_status("Could not determine the active project.")
                return
            self.push_screen(AddWorktreeModal(project), self._after_add_worktree_modal)
            return
        self.push_screen(AddWorkspaceModal(self.cwd), self._after_add_modal)

    def action_view_workspaces(self) -> None:
        self._skip_if_modal_open()
        project = self._selected_project()
        if not project:
            return

        self._mode = "workspaces"
        self._active_project_alias = project.alias
        self._workspaces = project.workspaces
        self._sync_list(clear_status=True)
        self.query_one("#projects-list", ListView).focus()

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id != "search-input":
            return

        self._clear_delete_confirmation()
        self._sync_list(clear_status=True)

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
        if (self._mode == "projects" and self._filtered_projects) or (self._mode == "workspaces" and self._filtered_workspaces):
            self.query_one("#projects-list", ListView).action_cursor_down()

    def action_cursor_up(self) -> None:
        if (self._mode == "projects" and self._filtered_projects) or (self._mode == "workspaces" and self._filtered_workspaces):
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
        self._sync_list(select_alias=alias)
        self.query_one("#projects-list", ListView).focus()
        self._set_status(result.stdout.strip() or f'Saved project "{alias}".')

    def _submit_add_worktree(self, project_alias: str, workspace_name: str, copy_from: str) -> None:
        if not workspace_name:
            self._set_status("Workspace name is required.")
            return

        args = ["workspace", "add", project_alias, workspace_name, "--copy-from", copy_from]

        result = self._run_cli(args)
        if result is None:
            return
        if result.returncode != 0:
            self._set_status(result.stderr.strip() or result.stdout.strip() or "Could not add workspace.")
            return

        self._refresh_projects()
        self._sync_list(select_workspace=workspace_name, clear_status=True)
        self.query_one("#projects-list", ListView).focus()
        self._set_status(result.stdout.strip() or f'Created workspace "{workspace_name}".')

    def _open_selected_target(self, *, in_tab: bool) -> None:
        flag = "--tab" if in_tab else "--current-session"
        tab_label = " in a new tab" if in_tab else ""

        if self._mode == "workspaces":
            project = self._active_project()
            workspace = self._selected_workspace()
            if project is None or workspace is None:
                return
            args = ["workspace", "open", project.alias, workspace.name, flag]
            fallback = f"Could not open workspace{tab_label}."
        else:
            project = self._selected_project()
            if not project:
                return
            args = ["project", "open", project.alias, flag]
            fallback = f"Could not open project{tab_label}."

        result = self._run_cli(args)
        if result is None:
            return
        if result.returncode != 0:
            self._set_status(result.stderr.strip() or result.stdout.strip() or fallback)
            return
        self.exit()

    def action_delete_selected(self) -> None:
        if self._mode != "projects":
            self._set_status("Workspace removal is available through the CLI for now.")
            return

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
        self._open_selected_target(in_tab=False)

    def action_open_selected_in_tab(self) -> None:
        self._open_selected_target(in_tab=True)


if __name__ == "__main__":
    import sys

    cwd = require_directory_arg(sys.argv, 1, "Usage: python3 ui/projects.py <cwd>")
    app = ProjectsApp(cwd)
    app.run()
