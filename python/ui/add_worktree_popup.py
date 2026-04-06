"""
Standalone popup for adding a workspace/worktree to a project.

Launched via `tmux display-popup` so it appears over the full terminal.

Usage:
    python3 ui/add_worktree_popup.py <project_alias> <output_file>

Writes "workspace_name\nbranch_name" to output_file on success, nothing on cancel.
"""

from __future__ import annotations

import re
import sys

try:
    from ._runtime import bootstrap_python_root
except ImportError:
    from _runtime import bootstrap_python_root

bootstrap_python_root()

from latch import theme
from latch.projects_store import ProjectInfo, load_projects, list_local_branches
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import Button, Footer, Header, Input, Static


CSS = """
Screen {
    background: %(app_bg)s;
    align: center middle;
    overflow: hidden hidden;
}

#popup-panel {
    background: %(modal_bg)s;
    border: round %(border)s;
    padding: 0;
    height: auto;
}

#popup-title {
    height: 2;
    padding: 0 2;
    border-bottom: solid %(border_subtle)s;
    color: %(text_high)s;
    text-style: bold;
    content-align: left middle;
}

#popup-body {
    padding: 1 2 0 2;
    height: auto;
    overflow-y: auto;
}

.wt-label {
    color: %(text_muted)s;
    height: 1;
    margin: 0;
}

.wt-input {
    border: round %(border)s;
    background: %(surface_bg)s;
    margin: 0 0 1 0;
    padding: 0 1;
}

.wt-input:focus {
    border: round %(border_focus)s;
}

#wt-path-display {
    height: 3;
    border: round %(border_subtle)s;
    background: %(app_bg)s;
    color: %(text_subtle)s;
    padding: 0 1;
    margin: 0 0 1 0;
    content-align: left middle;
}

#wt-branch-row {
    height: 3;
    margin: 0;
}

.wt-source-btn {
    height: 3;
    border: round %(border)s;
    background: %(surface_bg)s;
    color: %(text_muted)s;
    margin: 0 1 0 0;
}

.wt-source-btn.-active {
    border: round %(border_focus)s;
    color: %(text_high)s;
}

#wt-actions-row {
    height: 4;
    border-top: solid %(border_subtle)s;
    padding: 0 2;
}

#wt-cancel-btn {
    height: 3;
    border: round %(border)s;
    background: %(surface_bg)s;
    color: %(text_muted)s;
    margin: 0 1 0 0;
}

#wt-create-btn {
    height: 3;
    border: round %(accent)s;
    background: %(accent)s;
    color: %(text_high)s;
    text-style: bold;
}

#wt-create-btn:disabled {
    background: %(border_subtle)s;
    border: round %(border_subtle)s;
    color: %(text_subtle)s;
}

Header {
    display: none;
}

Footer {
    display: none;
}
""" % {
    "accent": theme.ACCENT,
    "app_bg": theme.APP_BG,
    "border": theme.BORDER,
    "border_focus": theme.BORDER_FOCUS,
    "border_subtle": theme.BORDER_SUBTLE,
    "modal_bg": theme.MODAL_BG,
    "surface_bg": theme.SURFACE_BG,
    "text_high": theme.TEXT_HIGH,
    "text_muted": theme.TEXT_MUTED,
    "text_subtle": theme.TEXT_SUBTLE,
}


class AddWorktreeApp(App):
    CSS = CSS

    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
        Binding("enter", "create", "Create", priority=True),
    ]

    def __init__(self, project: ProjectInfo, output_file: str) -> None:
        super().__init__()
        self.project = project
        self.output_file = output_file
        default_branch = next((workspace.branch for workspace in project.workspaces if workspace.is_default and workspace.branch), None)
        self._branch_suggestions = list_local_branches(project.root_path)
        if default_branch and default_branch in self._branch_suggestions:
            self._branch_suggestions = [default_branch] + [
                branch for branch in self._branch_suggestions if branch != default_branch
            ]
        self._branch_name = default_branch or (self._branch_suggestions[0] if self._branch_suggestions else "")

    def _slug(self, name: str) -> str:
        return re.sub(r"[^a-z0-9-]", "-", name.lower().strip()).strip("-")

    def _preview_path(self, name: str) -> str:
        slug = self._slug(name) or "<name>"
        return f".latch/workspaces/{slug}"

    def compose(self) -> ComposeResult:
        with Vertical(id="popup-panel"):
            yield Static("Add Workspace", id="popup-title")
            with Vertical(id="popup-body"):
                yield Static("Workspace name", classes="wt-label")
                yield Input(placeholder="e.g. feature-branch", id="wt-name-input", classes="wt-input")
                yield Static("Path", classes="wt-label")
                yield Static(self._preview_path(""), id="wt-path-display")
                yield Static("Base branch", classes="wt-label")
                yield Input(value=self._branch_name, placeholder="e.g. main", id="wt-branch-input", classes="wt-input")
                yield Static("Local branches", classes="wt-label")
                with Horizontal(id="wt-branch-row"):
                    for index, branch_name in enumerate(self._branch_suggestions):
                        yield Button(branch_name, id=f"wt-branch-{index}", classes="wt-source-btn")
            with Horizontal(id="wt-actions-row"):
                yield Button("esc  Cancel", id="wt-cancel-btn")
                yield Button("enter  Create", id="wt-create-btn", disabled=True)

    def _resize_panel(self) -> None:
        panel = self.query_one("#popup-panel")
        panel.styles.width = min(62, max(36, self.size.width - 6))
        panel.styles.height = "auto"
        panel.styles.max_height = max(12, self.size.height - 2)

    def on_mount(self) -> None:
        self._resize_panel()
        self._refresh_branch_buttons()
        self.query_one("#wt-create-btn", Button).disabled = not bool(
            self.query_one("#wt-name-input", Input).value.strip() and self._branch_name
        )
        self.query_one("#wt-name-input", Input).focus()

    def on_resize(self) -> None:
        self._resize_panel()

    def _refresh_branch_buttons(self) -> None:
        for index, branch_name in enumerate(self._branch_suggestions):
            btn = self.query_one(f"#wt-branch-{index}", Button)
            active = branch_name == self._branch_name
            btn.set_class(active, "-active")
            btn.label = f"● {branch_name}" if active else branch_name

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id == "wt-name-input":
            name = event.value
            self.query_one("#wt-path-display", Static).update(self._preview_path(name))
        elif event.input.id == "wt-branch-input":
            self._branch_name = event.value.strip()
            self._refresh_branch_buttons()
        else:
            return
        self.query_one("#wt-create-btn", Button).disabled = not bool(
            self.query_one("#wt-name-input", Input).value.strip() and self.query_one("#wt-branch-input", Input).value.strip()
        )

    def on_button_pressed(self, event: Button.Pressed) -> None:
        btn_id = event.button.id or ""
        if btn_id.startswith("wt-branch-"):
            index = int(btn_id[len("wt-branch-"):])
            self._branch_name = self._branch_suggestions[index]
            self.query_one("#wt-branch-input", Input).value = self._branch_name
            self._refresh_branch_buttons()
        elif btn_id == "wt-cancel-btn":
            self.action_cancel()
        elif btn_id == "wt-create-btn":
            self.action_create()

    def action_cancel(self) -> None:
        self.exit()

    def action_create(self) -> None:
        name = self.query_one("#wt-name-input", Input).value.strip()
        branch_name = self.query_one("#wt-branch-input", Input).value.strip()
        if not name or not branch_name:
            return
        slug = self._slug(name)
        try:
            with open(self.output_file, "w") as f:
                f.write(f"{slug}\n{branch_name}\n")
        except OSError:
            pass
        self.exit()


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 add_worktree_popup.py <project_alias> <output_file>", file=sys.stderr)
        sys.exit(1)

    alias = sys.argv[1]
    output_file = sys.argv[2]

    try:
        projects = load_projects()
    except Exception as e:
        print(f"Error loading projects: {e}", file=sys.stderr)
        sys.exit(1)

    project = next((p for p in projects if p.alias == alias), None)
    if project is None:
        print(f"Project {alias!r} not found", file=sys.stderr)
        sys.exit(1)

    app = AddWorktreeApp(project, output_file)
    app.run()
