from __future__ import annotations

import os
from typing import Optional, Tuple

from latch import theme
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Input, ListView, Static

try:
    from .projects_widgets import DirectorySuggestionItem, shorten_path
except ImportError:
    from projects_widgets import DirectorySuggestionItem, shorten_path


class AddWorkspaceModal(ModalScreen[Optional[Tuple[str, str]]]):
    CSS = """
    AddWorkspaceModal {
        align: center middle;
        background: %(overlay_bg)s;
    }

    #add-modal {
        width: 84;
        min-width: 60;
        max-width: 96%%;
        height: auto;
        background: %(modal_bg)s;
        padding: 0;
    }

    .main-panel {
        border: round %(border)s;
        background: %(app_bg)s;
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
        color: %(text_secondary)s;
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
        color: %(text_muted)s;
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
        border: round %(border_subtle)s;
        background: %(panel_bg)s;
        padding: 0 1;
    }

    #matches-title {
        color: %(text_muted)s;
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
        color: %(text_muted)s;
    }

    .directory-row.-selected {
        background: %(selection_bg)s;
        color: %(text_high)s;
    }

    #preview-title {
        color: %(text_secondary)s;
        text-style: bold;
        padding: 0 0 1 0;
    }

    #preview-content {
        color: %(text_muted)s;
    }

    .action-button {
        width: auto;
        min-width: 18;
        color: %(text_button)s;
        background: %(button_bg)s;
        border: tall %(border)s;
        content-align: center middle;
        padding: 0 2;
        margin: 0 1 0 0;
    }

    .action-button.-primary {
        background: %(button_bg_primary)s;
        border: tall %(button_border_primary)s;
    }
    """ % {
        "app_bg": theme.APP_BG,
        "border": theme.BORDER,
        "border_subtle": theme.BORDER_SUBTLE,
        "button_bg": theme.BUTTON_BG,
        "button_bg_primary": theme.BUTTON_BG_PRIMARY,
        "button_border_primary": theme.BUTTON_BORDER_PRIMARY,
        "modal_bg": theme.MODAL_BG,
        "overlay_bg": theme.OVERLAY_BG,
        "panel_bg": theme.PANEL_BG,
        "selection_bg": theme.SELECTION_BG,
        "text_button": theme.TEXT_BUTTON,
        "text_high": theme.TEXT_HIGH,
        "text_muted": theme.TEXT_MUTED,
        "text_primary": theme.TEXT_PRIMARY,
        "text_secondary": theme.TEXT_SECONDARY,
    }

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
