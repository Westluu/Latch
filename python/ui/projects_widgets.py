from __future__ import annotations

import os

from latch import theme
from latch.projects_store import ProjectInfo, WorkspaceInfo
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widgets import ListItem, Static


def shorten_path(path: str, max_len: int = 52) -> str:
    home = os.path.expanduser("~")
    display = path.replace(home, "~", 1) if path.startswith(home) else path
    if len(display) <= max_len:
        return display
    return "..." + display[-(max_len - 3):]


PROJECTS_LIST_CSS = """
Screen {
    background: %(app_bg)s;
}

#search-input {
    margin: 0 0 1 0;
}

#projects-list {
    border: round %(border)s;
    padding: 1;
    background: %(panel_bg)s;
}

#projects-list:focus-within {
    border: round %(border_focus)s;
}

#empty-state {
    color: %(text_subtle)s;
    padding: 1 2;
}

#status {
    color: %(text_error_soft)s;
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
    background: %(row_selection_bg)s;
    border-left: wide %(accent)s;
    padding: 1 1 1 1;
}

.project-icon {
    width: 3;
    padding: 0 0 0 0;
    color: %(text_icon)s;
    text-style: bold;
}

.project-row.-selected .project-icon {
    color: %(accent_soft)s;
}

.project-content {
    width: 1fr;
    height: auto;
    padding: 0;
}

.project-alias {
    color: %(text_primary)s;
    text-style: bold;
    padding: 0;
    height: auto;
}

.project-path {
    color: %(text_muted)s;
    padding: 0;
    height: auto;
}

.project-meta {
    color: %(text_subtle)s;
    padding: 0;
    height: auto;
}

.project-row.-selected .project-alias {
    color: %(text_high)s;
}

.project-row.-selected .project-meta {
    color: %(accent_pale)s;
}

.project-row.-selected .project-path {
    color: %(text_secondary)s;
}
""" % {
    "accent": theme.ACCENT,
    "accent_pale": theme.ACCENT_PALE,
    "accent_soft": theme.ACCENT_SOFT,
    "app_bg": theme.APP_BG,
    "border": theme.BORDER,
    "border_focus": theme.BORDER_FOCUS,
    "panel_bg": theme.PANEL_BG,
    "row_selection_bg": theme.ROW_SELECTION_BG,
    "text_error_soft": theme.TEXT_ERROR_SOFT,
    "text_high": theme.TEXT_HIGH,
    "text_icon": theme.TEXT_ICON,
    "text_muted": theme.TEXT_MUTED,
    "text_primary": theme.TEXT_PRIMARY,
    "text_secondary": theme.TEXT_SECONDARY,
    "text_subtle": theme.TEXT_SUBTLE,
}


class ProjectListItem(ListItem):
    def __init__(self, project: ProjectInfo) -> None:
        super().__init__()
        self.project = project
        self._icon = Static(">", classes="project-icon")
        self._alias = Static(project.alias, classes="project-alias")
        workspace_count = len(project.workspaces)
        count_label = "workspace" if workspace_count == 1 else "workspaces"
        self._path = Static(shorten_path(project.root_path, 68), classes="project-path")
        self._meta = Static(f"{workspace_count} {count_label}", classes="project-meta")
        self._content = Vertical(self._alias, self._meta, self._path, classes="project-content")
        self._row = Horizontal(self._icon, self._content, classes="project-row")

    def compose(self) -> ComposeResult:
        yield self._row

    def set_selected(self, selected: bool) -> None:
        self._row.set_class(selected, "-selected")


class WorkspaceListItem(ListItem):
    def __init__(self, workspace: WorkspaceInfo) -> None:
        super().__init__()
        self.workspace = workspace
        self._icon = Static(">", classes="project-icon")
        label = workspace.name + (" *" if workspace.is_default else "")
        self._alias = Static(label, classes="project-alias")
        details = workspace.kind
        if workspace.branch:
            details = f"{details}  {workspace.branch}"
        self._meta = Static(details, classes="project-meta")
        self._path = Static(shorten_path(workspace.path, 68), classes="project-path")
        self._content = Vertical(self._alias, self._meta, self._path, classes="project-content")
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
        label = f"[bold {theme.TEXT_PRIMARY}]{name}/[/] [{theme.TEXT_SUBTLE}]{parent}[/]"
        self._row = Static(label, classes="directory-row")

    def compose(self) -> ComposeResult:
        yield self._row

    def set_selected(self, selected: bool) -> None:
        self._row.set_class(selected, "-selected")
