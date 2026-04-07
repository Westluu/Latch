from __future__ import annotations

import os

from latch import theme
from latch.projects_store import ProjectInfo, WorkspaceInfo
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.widgets import ListItem, Static


def shorten_path(path: str, max_len: int = 52) -> str:
    home = os.path.expanduser("~")
    display = path.replace(home, "~", 1) if path.startswith(home) else path
    if len(display) <= max_len:
        return display

    separator = os.sep
    prefix = "~" if display.startswith("~" + separator) else (separator if display.startswith(separator) else "")
    body = display[len(prefix):] if prefix else display
    parts = [segment for segment in body.split(separator) if segment]
    if not parts:
        return display[:max_len]

    for suffix_count in range(min(len(parts), 4), 0, -1):
        suffix = separator.join(parts[-suffix_count:])
        if prefix:
            candidate = f"{prefix}...{separator}{suffix}"
        else:
            head = parts[0]
            candidate = f"{head}{separator}...{separator}{suffix}"
        if len(candidate) <= max_len:
            return candidate

    return "..." + display[-(max_len - 3):]


def workspace_label(workspace: WorkspaceInfo) -> str:
    return "root" if workspace.kind == "root" else workspace.name


def workspace_branch_label(workspace: WorkspaceInfo) -> str:
    return workspace.branch or "no branch"


def workspace_kind_icon(workspace: WorkspaceInfo) -> str:
    return "⌂" if workspace.kind == "root" else "⎇"


PROJECTS_LIST_CSS = """
Screen {
    background: %(app_bg)s;
}

#projects-topbar {
    height: 4;
    padding: 1 2 0 2;
    border-bottom: solid %(border_subtle)s;
    background: %(app_bg)s;
    align: left middle;
}

#projects-left {
    width: auto;
    color: %(text_muted)s;
    text-style: bold;
    text-wrap: nowrap;
    text-overflow: ellipsis;
    content-align: left middle;
}

#projects-center {
    width: 1fr;
    color: %(text_muted)s;
    text-style: bold;
    text-wrap: nowrap;
    text-overflow: ellipsis;
    content-align: center middle;
}

#projects-right {
    width: auto;
    content-align: right middle;
    align: right middle;
}

#projects-brand-dot {
    width: auto;
    color: %(accent_github)s;
    text-style: bold;
    margin: 0 1 0 0;
}

#projects-brand-text {
    width: auto;
    color: %(text_primary)s;
    text-style: bold;
}

Footer {
    background: %(app_bg)s;
    color: %(text_subtle)s;
    height: 1;
}

.footer--key {
    background: %(app_bg)s;
    color: %(accent)s;
    text-style: bold;
}

.footer--description {
    color: %(text_subtle)s;
    background: %(app_bg)s;
}

.footer--spacer {
    background: %(app_bg)s;
}

#search-bar {
    margin: 0 1 1 1;
    border: none;
    background: %(row_selection_bg)s;
    height: 3;
    align: left middle;
}

#search-bar:focus-within {
    border: round %(border_focus)s;
}

#search-icon {
    width: 3;
    color: %(text_subtle)s;
    padding: 0 0 0 1;
    height: 1;
}

#search-bar:focus-within #search-icon {
    color: %(border_focus)s;
}

#search-input {
    border: none;
    background: transparent;
    padding: 0;
    height: 1;
    width: 1fr;
    color: %(text_primary)s;
}

#projects-list {
    border: none;
    padding: 0;
    background: %(app_bg)s;
    width: 100%%;
    height: 1fr;
}

#projects-list:focus {
    background: %(app_bg)s;
    background-tint: transparent 0%%;
}

#projects-list > ListItem {
    background: transparent;
}

#projects-list > ListItem.-highlight {
    background: transparent;
    color: %(text_primary)s;
}

#projects-list:focus > ListItem.-highlight {
    background: transparent;
    color: %(text_primary)s;
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
    height: 10vh;
    padding: 1 0 1 2;
    background: transparent;
}

.project-row.-selected {
    background: %(row_selection_bg)s;
    border-left: outer %(accent_github)s;
    padding: 1 0 1 1;
}

.project-alias {
    color: %(text_muted)s;
    text-style: bold;
    padding: 0;
    height: auto;
}

.project-path {
    color: %(text_faint)s;
    padding: 0;
    height: auto;
}

.project-meta {
    color: %(text_faint)s;
    padding: 0;
    height: auto;
}

.project-row.-selected .project-alias {
    color: %(text_primary)s;
}

.project-row.-selected .project-meta {
    color: %(text_subtle)s;
}

.project-row.-selected .project-path {
    color: %(text_faint)s;
}

""" % {
    "accent": theme.ACCENT,
    "accent_github": "#4493F8",
    "app_bg": theme.APP_BG,
    "border_focus": theme.BORDER_FOCUS,
    "border_subtle": theme.BORDER_SUBTLE,
    "row_selection_bg": theme.ROW_SELECTION_BG,
    "text_error_soft": theme.TEXT_ERROR_SOFT,
    "text_faint": theme.TEXT_FAINT,
    "text_muted": theme.TEXT_MUTED,
    "text_primary": theme.TEXT_PRIMARY,
    "text_subtle": theme.TEXT_SUBTLE,
}


class ProjectListItem(ListItem):
    def __init__(self, project: ProjectInfo) -> None:
        super().__init__()
        self.project = project
        self._alias = Static(project.alias, classes="project-alias")
        workspace_count = len(project.workspaces)
        count_label = "workspace" if workspace_count == 1 else "workspaces"
        self._meta = Static(f"{workspace_count} {count_label}", classes="project-meta")
        self._path = Static(shorten_path(project.root_path, 68), classes="project-path")
        self._row = Vertical(self._alias, self._meta, self._path, classes="project-row")

    def compose(self) -> ComposeResult:
        yield self._row

    def set_selected(self, selected: bool) -> None:
        self._row.set_class(selected, "-selected")


class WorkspaceListItem(ListItem):
    def __init__(self, workspace: WorkspaceInfo) -> None:
        super().__init__()
        self.workspace = workspace
        self._alias = Static(
            f"{workspace_kind_icon(workspace)}  {workspace_label(workspace)}",
            classes="project-alias",
        )
        self._meta = Static(f"⑂  {workspace_branch_label(workspace)}", classes="project-meta")
        self._path = Static(shorten_path(workspace.path, 52), classes="project-path")
        self._row = Vertical(self._alias, self._meta, self._path, classes="project-row")

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
        self._name = Static(f"{name}/", classes="directory-name")
        self._parent = Static(parent, classes="directory-parent")
        self._row = Vertical(self._name, self._parent, classes="directory-row")

    def compose(self) -> ComposeResult:
        yield self._row

    def set_selected(self, selected: bool) -> None:
        self._row.set_class(selected, "-selected")
