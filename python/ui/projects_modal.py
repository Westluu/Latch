from __future__ import annotations

import os
import re
from typing import Optional, Tuple

from latch import theme
from latch.projects_store import ProjectInfo
from textual import events
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Input, ListView, Select, Static

try:
    from .projects_widgets import DirectorySuggestionItem, shorten_path
except ImportError:
    from projects_widgets import DirectorySuggestionItem, shorten_path


class AddWorkspaceModal(ModalScreen[Optional[Tuple[str, str]]]):
    CSS = """
    AddWorkspaceModal {
        align: center top;
        background: %(overlay_bg)s;
        padding: 1 0 0 0;
    }

    #add-modal {
        width: 76;
        min-width: 54;
        max-width: 92%%;
        height: 31;
        background: %(modal_bg)s;
        border: round %(border)s;
        padding: 0 1;
        overflow: hidden hidden;
    }

    #add-header {
        height: 4;
        padding: 0 1 0 2;
        border-bottom: solid %(border_subtle)s;
        align: left middle;
    }

    #add-title {
        width: 1fr;
        color: %(text_high)s;
        text-style: bold;
        content-align: left middle;
    }

    #add-close-hint {
        width: auto;
        color: %(text_subtle)s;
        content-align: right middle;
    }

    #add-body {
        padding: 1 1 0 1;
        height: 1fr;
        overflow-y: hidden;
    }

    #add-footer {
        height: 4;
        border-top: solid %(border_subtle)s;
        padding: 0 1;
        align: left middle;
    }

    .add-footer-spacer {
        width: 1fr;
    }

    #add-footer-buttons {
        width: auto;
        height: 3;
        align: center middle;
    }

    .add-field-row {
        height: auto;
        align: left top;
    }

    .add-input-label {
        width: 10;
        min-width: 10;
        color: %(text_muted)s;
        padding: 1 0 0 0;
    }

    .add-input {
        border: round %(border)s;
        background: %(panel_bg)s;
        margin: 0 0 1 0;
        padding: 0 1;
        color: %(text_primary)s;
    }

    .add-input:focus {
        border: round %(border_focus)s;
    }

    .add-field-stack {
        width: 1fr;
        min-width: 0;
    }

    #modal-alias,
    #modal-path {
        width: 1fr;
    }

    #matches-panel {
        width: 1fr;
        min-width: 0;
        height: auto;
        margin: 0;
        border: round %(border_subtle)s;
        background: %(panel_bg)s;
        padding: 0 1;
    }

    #matches-panel:focus-within {
        border: round %(border_focus)s;
    }

    #matches-title {
        color: %(text_muted)s;
        padding: 0 0 1 0;
    }

    #matches-list {
        height: 7;
        padding: 0;
        border: none;
        background: transparent;
    }

    #modal-path {
        margin: 0;
    }

    ListView > ListItem {
        padding: 0;
        background: transparent;
        width: 1fr;
        height: auto;
    }

    .directory-row {
        width: 1fr;
        height: auto;
        padding: 0 1 0 2;
        background: transparent;
    }

    .directory-row.-selected {
        background: %(row_selection_bg)s;
        border-left: outer %(accent_github)s;
        padding: 0 1 0 1;
    }

    .directory-name {
        color: %(text_muted)s;
        text-style: bold;
        padding: 0;
        height: auto;
    }

    .directory-parent {
        color: %(text_subtle)s;
        padding: 0;
        height: auto;
    }

    .directory-row.-selected .directory-name {
        color: %(text_primary)s;
    }

    .directory-row.-selected .directory-parent {
        color: %(text_subtle)s;
    }

    Button.add-action-btn {
        width: 18;
        min-width: 18;
        max-width: 18;
        height: 3;
        padding: 0;
        border: round %(border)s;
        background: %(panel_bg)s;
        color: %(text_muted)s;
        margin: 0 1 0 0;
        content-align: center middle;
        text-align: center;
    }

    Button#add-create-btn {
        margin: 0;
    }

    Button#add-cancel-btn {
        background: %(panel_bg)s;
        color: %(text_secondary)s;
    }

    Button#add-cancel-btn:focus,
    Button#add-create-btn:focus {
        border: round %(border_focus)s;
        background: %(panel_bg)s;
        color: %(text_primary)s;
    }

    Button#add-create-btn {
        border: round %(accent_soft)s;
        background: %(panel_bg)s;
        color: %(accent_soft)s;
    }

    Button#add-create-btn:disabled {
        background: %(panel_bg)s;
        border: round %(border_subtle)s;
        color: %(text_subtle)s;
    }
    """ % {
        "accent_github": "#4493F8",
        "accent_soft": theme.ACCENT_SOFT,
        "border": theme.BORDER,
        "border_focus": theme.BORDER_FOCUS,
        "border_subtle": theme.BORDER_SUBTLE,
        "modal_bg": theme.MODAL_BG,
        "overlay_bg": theme.OVERLAY_BG,
        "panel_bg": theme.PANEL_BG,
        "row_selection_bg": theme.ROW_SELECTION_BG,
        "text_high": theme.TEXT_HIGH,
        "text_muted": theme.TEXT_MUTED,
        "text_primary": theme.TEXT_PRIMARY,
        "text_secondary": theme.TEXT_SECONDARY,
        "text_subtle": theme.TEXT_SUBTLE,
    }

    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
        Binding("tab", "tab_next", show=False, priority=True),
        Binding("shift+tab", "tab_prev", show=False, priority=True),
    ]

    def __init__(self, cwd: str) -> None:
        super().__init__()
        self.cwd = cwd
        self._suggestion_paths: list[str] = []
        self._suggestion_items: list[DirectorySuggestionItem] = []

    def compose(self) -> ComposeResult:
        with Vertical(id="add-modal"):
            with Horizontal(id="add-header"):
                yield Static("Add Project", id="add-title")
                yield Static("esc", id="add-close-hint")
            with Vertical(id="add-body"):
                with Horizontal(classes="add-field-row"):
                    yield Static("Project name", classes="add-input-label")
                    yield Input(placeholder="Alias", id="modal-alias", classes="add-input")
                with Horizontal(classes="add-field-row"):
                    yield Static("Project path", classes="add-input-label")
                    with Vertical(classes="add-field-stack"):
                        yield Input(value=self.cwd, placeholder="Path", id="modal-path", classes="add-input")
                        with Vertical(id="matches-panel"):
                            yield Static("MATCHES (TAB TO NAVIGATE)", id="matches-title")
                            yield ListView(id="matches-list")
            with Horizontal(id="add-footer"):
                yield Static("", classes="add-footer-spacer")
                with Horizontal(id="add-footer-buttons"):
                    yield Button("esc  Cancel", id="add-cancel-btn", classes="add-action-btn")
                    yield Button("enter  Add", id="add-create-btn", classes="add-action-btn", disabled=True)
                yield Static("", classes="add-footer-spacer")

    def on_mount(self) -> None:
        self._refresh_matches()
        self._refresh_create_button()
        self.query_one("#modal-alias", Input).focus()

    def action_cancel(self) -> None:
        self.dismiss(None)

    def action_create(self) -> None:
        alias = self.query_one("#modal-alias", Input).value.strip()
        path = self._submission_path()
        if not alias:
            self.query_one("#modal-alias", Input).focus()
            return
        self.dismiss((alias, path))

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

        display_path = self._display_path(selected_path)
        if not display_path.endswith(os.sep):
            display_path = f"{display_path}{os.sep}"
        path_input.value = display_path
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

    def _submission_path(self) -> str:
        resolved = self._resolve_input_path()
        if os.path.isdir(resolved):
            return resolved
        return self._selected_suggestion_path() or self.query_one("#modal-path", Input).value.strip() or self.cwd

    def _refresh_create_button(self) -> None:
        alias = self.query_one("#modal-alias", Input).value.strip()
        self.query_one("#add-create-btn", Button).disabled = not bool(alias)

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

    def action_tab_next(self) -> None:
        alias_input = self.query_one("#modal-alias", Input)
        path_input = self.query_one("#modal-path", Input)
        matches_list = self.query_one("#matches-list", ListView)
        cancel_button = self.query_one("#add-cancel-btn", Button)
        create_button = self.query_one("#add-create-btn", Button)

        if self.focused is alias_input:
            path_input.focus()
            return
        if self.focused is path_input:
            if self._suggestion_paths:
                matches_list.focus()
            else:
                cancel_button.focus()
            return
        if self.focused is matches_list:
            cancel_button.focus()
            return
        if self.focused is cancel_button and not create_button.disabled:
            create_button.focus()
            return
        alias_input.focus()

    def action_tab_prev(self) -> None:
        alias_input = self.query_one("#modal-alias", Input)
        path_input = self.query_one("#modal-path", Input)
        matches_list = self.query_one("#matches-list", ListView)
        cancel_button = self.query_one("#add-cancel-btn", Button)
        create_button = self.query_one("#add-create-btn", Button)

        if self.focused is path_input:
            alias_input.focus()
            return
        if self.focused is matches_list:
            path_input.focus()
            return
        if self.focused is create_button:
            cancel_button.focus()
            return
        if self.focused is cancel_button:
            if self._suggestion_paths:
                matches_list.focus()
            else:
                path_input.focus()
            return
        alias_input.focus()

    def action_next_match(self) -> None:
        if not self._suggestion_paths:
            return
        list_view = self.query_one("#matches-list", ListView)
        current_index = list_view.index or 0
        next_index = (current_index + 1) % len(self._suggestion_paths)
        list_view.index = next_index
        self._set_selected_suggestion(next_index)

    def action_prev_match(self) -> None:
        if not self._suggestion_paths:
            return
        list_view = self.query_one("#matches-list", ListView)
        current_index = list_view.index or 0
        next_index = (current_index - 1) % len(self._suggestion_paths)
        list_view.index = next_index
        self._set_selected_suggestion(next_index)

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id == "modal-alias":
            self._refresh_create_button()
            return
        if event.input.id == "modal-path":
            self._refresh_matches()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        btn_id = event.button.id or ""
        if btn_id == "add-cancel-btn":
            self.action_cancel()
        elif btn_id == "add-create-btn":
            self.action_create()

    def on_list_view_highlighted(self, event: ListView.Highlighted) -> None:
        if event.list_view.id != "matches-list":
            return
        self._set_selected_suggestion(event.list_view.index)

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        if event.list_view.id != "matches-list":
            return
        self._apply_selected_suggestion()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "modal-alias":
            alias = event.value.strip()
            if not alias:
                return
            self.query_one("#modal-path", Input).focus()
            return

        if self._apply_selected_suggestion():
            return

        self.action_create()


class AddWorktreeModal(ModalScreen[Optional[Tuple[str, str]]]):
    """Modal for adding a new workspace/worktree to an existing project.

    Dismisses with (workspace_name, copy_from) where copy_from is the
    workspace name to base the new workspace on, or None if cancelled.
    """

    CSS = """
    AddWorktreeModal {
        align: center top;
        background: %(overlay_bg)s;
        padding: 1 0 0 0;
    }

    #worktree-modal {
        width: 76;
        min-width: 54;
        max-width: 92%%;
        max-height: 100%%;
        background: %(modal_bg)s;
        border: round %(border)s;
        padding: 0 1;
        height: auto;
    }

    #worktree-header {
        height: 4;
        padding: 0 1 0 2;
        border-bottom: solid %(border_subtle)s;
        align: left middle;
    }

    #worktree-title {
        width: 1fr;
        color: %(text_high)s;
        text-style: bold;
        content-align: left middle;
    }

    #worktree-close-hint {
        width: auto;
        color: %(text_subtle)s;
        content-align: right middle;
    }

    #worktree-body {
        padding: 1 2;
        height: auto;
    }

    .wt-label {
        color: %(text_muted)s;
        height: 1;
        margin: 1 0 0 0;
    }

    .wt-input {
        width: 1fr;
        border: round %(border)s;
        background: %(panel_bg)s;
        margin: 0 0 1 0;
        padding: 0 1;
        color: %(text_primary)s;
    }

    .wt-input:focus {
        border: round %(border_focus)s;
    }

    #wt-path-display {
        height: 3;
        border: round %(border_subtle)s;
        background: %(panel_bg)s;
        color: %(text_subtle)s;
        padding: 0 1;
        margin: 0 0 1 0;
        content-align: left middle;
    }

    #wt-copy-select {
        width: 1fr;
        height: auto;
        margin: 0 0 1 0;
    }

    #wt-copy-select > SelectCurrent {
        border: round %(border)s;
        background: %(panel_bg)s;
        color: %(text_primary)s;
        padding: 0 1;
    }

    #wt-copy-select:focus > SelectCurrent,
    #wt-copy-select.-expanded > SelectCurrent {
        border: round %(border_focus)s;
    }

    #wt-copy-select > SelectOverlay {
        width: 1fr;
        max-height: 8;
        border: round %(border_subtle)s;
        background: %(panel_bg)s;
        color: %(text_primary)s;
    }

    #wt-copy-select .option-list--option {
        padding: 0 1;
        color: %(text_muted)s;
    }

    #wt-copy-select .option-list--option-highlighted,
    #wt-copy-select .option-list--option-hover {
        background: %(row_selection_bg)s;
        color: %(text_high)s;
    }

    #wt-footer {
        height: 4;
        border-top: solid %(border_subtle)s;
        padding: 0 1 0 2;
        align: left middle;
    }

    #wt-footer-spacer {
        width: 1fr;
    }

    Button.wt-action-btn {
        width: 18;
        min-width: 18;
        max-width: 18;
        height: 3;
        padding: 0;
        border: round %(border)s;
        background: %(panel_bg)s;
        color: %(text_muted)s;
        margin: 0 0 0 1;
        content-align: center middle;
        text-align: center;
    }

    Button#wt-cancel-btn {
        background: %(panel_bg)s;
        color: %(text_secondary)s;
    }

    Button#wt-cancel-btn:focus {
        border: round %(border_focus)s;
        color: %(text_primary)s;
    }

    Button#wt-create-btn {
        border: round %(accent_soft)s;
        background: %(panel_bg)s;
        color: %(accent_soft)s;
    }

    Button#wt-create-btn:focus {
        border: round %(border_focus)s;
        background: %(panel_bg)s;
        color: %(text_primary)s;
    }

    Button#wt-create-btn:disabled {
        background: %(panel_bg)s;
        border: round %(border_subtle)s;
        color: %(text_subtle)s;
    }
    """ % {
        "accent": theme.ACCENT,
        "accent_soft": theme.ACCENT_SOFT,
        "app_bg": theme.APP_BG,
        "border": theme.BORDER,
        "border_focus": theme.BORDER_FOCUS,
        "border_subtle": theme.BORDER_SUBTLE,
        "modal_bg": theme.MODAL_BG,
        "overlay_bg": theme.OVERLAY_BG,
        "panel_bg": theme.PANEL_BG,
        "text_high": theme.TEXT_HIGH,
        "text_muted": theme.TEXT_MUTED,
        "text_primary": theme.TEXT_PRIMARY,
        "text_secondary": theme.TEXT_SECONDARY,
        "text_subtle": theme.TEXT_SUBTLE,
        "row_selection_bg": theme.ROW_SELECTION_BG,
    }

    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
        Binding("left", "footer_left", show=False, priority=True),
        Binding("right", "footer_right", show=False, priority=True),
    ]

    def __init__(self, project: ProjectInfo) -> None:
        super().__init__()
        self.project = project
        self._workspace_names: list[str] = [w.name for w in project.workspaces]
        preferred_workspace = project.default_workspace if project.default_workspace in self._workspace_names else None
        self._copy_from: str = preferred_workspace or self._workspace_names[0]

    def _copy_from_options(self) -> list[tuple[str, str]]:
        return [(name, name) for name in self._workspace_names]

    def _slug(self, name: str) -> str:
        return re.sub(r"[^a-z0-9-]", "-", name.lower().strip()).strip("-")

    def _preview_path(self, name: str) -> str:
        slug = self._slug(name) or "<name>"
        return f".latch/workspaces/{slug}"

    def compose(self) -> ComposeResult:
        with Vertical(id="worktree-modal"):
            with Horizontal(id="worktree-header"):
                yield Static("Add Workspace", id="worktree-title")
                yield Static("esc", id="worktree-close-hint")
            with Vertical(id="worktree-body"):
                yield Static("Workspace name", classes="wt-label")
                yield Input(placeholder="e.g. feature-branch", id="wt-name-input", classes="wt-input")
                yield Static("Path", classes="wt-label")
                yield Static(self._preview_path(""), id="wt-path-display")
                yield Static("Base workspace", classes="wt-label")
                yield Select(
                    self._copy_from_options(),
                    value=self._copy_from,
                    allow_blank=False,
                    id="wt-copy-select",
                )
            with Horizontal(id="wt-footer"):
                yield Static("", id="wt-footer-spacer")
                yield Button("esc  Cancel", id="wt-cancel-btn", classes="wt-action-btn")
                yield Button("enter  Create", id="wt-create-btn", classes="wt-action-btn", disabled=True)

    def on_mount(self) -> None:
        self.query_one("#wt-copy-select", Select).value = self._copy_from
        self.query_one("#wt-name-input", Input).focus()

    def _refresh_path(self) -> None:
        name = self.query_one("#wt-name-input", Input).value
        self.query_one("#wt-path-display", Static).update(self._preview_path(name))

    def _refresh_create_button(self) -> None:
        name = self.query_one("#wt-name-input", Input).value.strip()
        self.query_one("#wt-create-btn", Button).disabled = not bool(name)

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id == "wt-name-input":
            self._refresh_path()
            self._refresh_create_button()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "wt-name-input":
            return
        self.action_create()

    def on_select_changed(self, event: Select.Changed) -> None:
        if event.select.id != "wt-copy-select":
            return
        self._copy_from = str(event.value)

    def on_key(self, event: events.Key) -> None:
        if event.key not in {"up", "down"}:
            return

        focused = self.focused
        if focused is None:
            return

        name_input = self.query_one("#wt-name-input", Input)
        copy_select = self.query_one("#wt-copy-select", Select)
        cancel_button = self.query_one("#wt-cancel-btn", Button)
        create_button = self.query_one("#wt-create-btn", Button)

        if focused is name_input and event.key == "down":
            copy_select.focus()
            event.stop()
            return

        if focused in {cancel_button, create_button} and event.key == "up":
            copy_select.focus()
            event.stop()

    def _footer_buttons(self) -> tuple[Button, Button]:
        return (
            self.query_one("#wt-cancel-btn", Button),
            self.query_one("#wt-create-btn", Button),
        )

    def action_footer_left(self) -> None:
        cancel_button, create_button = self._footer_buttons()
        if self.focused in {cancel_button, create_button}:
            cancel_button.focus()

    def action_footer_right(self) -> None:
        cancel_button, create_button = self._footer_buttons()
        if self.focused in {cancel_button, create_button} and not create_button.disabled:
            create_button.focus()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        btn_id = event.button.id or ""
        if btn_id == "wt-cancel-btn":
            self.action_cancel()
        elif btn_id == "wt-create-btn":
            self.action_create()

    def action_cancel(self) -> None:
        self.dismiss(None)

    def action_create(self) -> None:
        name = self.query_one("#wt-name-input", Input).value.strip()
        if not name:
            return
        self.dismiss((self._slug(name), self._copy_from))
