from __future__ import annotations

from latch import theme
from latch.session_store import Message, SessionInfo
from rich.text import Text
from textual.binding import Binding
from textual.widgets import ListItem, ListView, Static

try:
    from .chat_render import format_duration, format_size, render_one_message
except ImportError:
    from chat_render import format_duration, format_size, render_one_message


CHAT_APP_CSS = """
Screen {
    background: %(app_bg)s;
}

#left-panel {
    width: 30%%;
    border: round %(border)s;
    padding: 0 1;
}

#left-panel:focus-within {
    border: round %(border_focus)s;
}

#search-input {
    height: 1;
    border: none;
    background: %(surface_bg)s;
    color: %(text_bright)s;
    padding: 0 1;
    margin: 0 0 1 0;
}

#session-list {
    height: 1fr;
    background: transparent;
    border: none;
    padding: 0;
}

#right-panel {
    width: 70%%;
    border: round %(border)s;
    padding: 0;
}

#right-panel:focus-within {
    border: round %(border_focus)s;
}

#session-header {
    height: auto;
    padding: 0 1;
}

#message-list {
    height: 1fr;
    background: transparent;
    border: none;
    padding: 0;
}

#msg-empty {
    color: %(text_faint)s;
    padding: 1 2;
}

ListView > ListItem {
    padding: 0;
    background: transparent;
    color: %(text_soft)s;
    width: 1fr;
}
""" % {
    "app_bg": theme.APP_BG,
    "border": theme.BORDER,
    "border_focus": theme.BORDER_FOCUS,
    "surface_bg": theme.SURFACE_BG,
    "text_bright": theme.TEXT_BRIGHT,
    "text_faint": theme.TEXT_FAINT,
    "text_soft": theme.TEXT_SOFT,
}


class SessionListView(ListView):
    BINDINGS = [
        Binding("j", "cursor_down", "Down", show=False),
        Binding("k", "cursor_up", "Up", show=False),
    ]


class MessageListView(ListView):
    BINDINGS = [
        Binding("j", "cursor_down", "Down", show=False),
        Binding("k", "cursor_up", "Up", show=False),
    ]


class SessionListItem(ListItem):
    DEFAULT_CSS = """
    SessionListItem {
        height: 1;
        background: transparent;
    }
    SessionListItem Static {
        width: 1fr;
        background: transparent;
    }
    """

    def __init__(self, session: SessionInfo) -> None:
        self.session = session
        label = session.label
        if len(label) > 28:
            label = label[:25] + "..."
        self._duration_text = format_duration(session.duration_secs)
        self._size_text = format_size(session.file_size)

        branch = session.branch or ""
        if len(branch) > 20:
            branch = "..." + branch[-17:]
        self._branch_text = branch
        self._label_text = f"\u25c6 {label}"
        self._content = Static(self._render_text(selected=False))
        super().__init__(self._content)

    def set_selected(self, selected: bool) -> None:
        background = theme.SELECTION_BG if selected else "transparent"
        self.styles.background = background
        self._content.styles.background = background
        self._content.update(self._render_text(selected))

    def _render_text(self, selected: bool) -> Text:
        text = Text()
        text.append("\u25c6 ", style=theme.WARNING)
        text.append(self._label_text[2:], style=theme.TEXT_BRIGHT if selected else theme.TEXT_SOFT)
        if self._duration_text:
            text.append("  ")
            text.append(self._duration_text, style=theme.TEXT_SUBTLE)
        if self._size_text:
            text.append("  ")
            text.append(self._size_text, style=theme.TEXT_FAINT)

        if self._branch_text:
            text.append("  ")
            text.append(self._branch_text, style=theme.TEXT_MUTED if selected else theme.TEXT_SUBTLE)

        return text


class GroupHeader(ListItem):
    def __init__(self, label: str) -> None:
        markup = f"[bold {theme.WARNING}]{label}[/]" if label else ""
        super().__init__(Static(markup))
        self.disabled = True


class LoadMoreItem(ListItem):
    DEFAULT_CSS = """
    LoadMoreItem {
        height: 3;
        background: transparent;
        padding: 0;
        margin: 0 0 1 0;
    }
    LoadMoreItem Static {
        width: 1fr;
        background: transparent;
        text-align: center;
        padding: 1 0;
    }
    LoadMoreItem.-highlight Static {
        background: %(surface_bg)s;
        color: %(warning)s;
    }
    """ % {
        "surface_bg": theme.SURFACE_BG,
        "warning": theme.WARNING,
    }

    def __init__(self) -> None:
        super().__init__(Static(f"[{theme.TEXT_SUBTLE}]─── [bold]↑ load older messages[/bold] (enter) ───[/]"))


class TurnSeparatorItem(ListItem):
    DEFAULT_CSS = """
    TurnSeparatorItem {
        height: 1;
        background: transparent;
        padding: 0;
    }
    TurnSeparatorItem Static {
        width: 1fr;
        background: transparent;
    }
    """

    def __init__(self) -> None:
        super().__init__(Static("  " + "─" * 20, markup=False))
        self.styles.color = theme.SELECTION_BG
        self.disabled = True


class MessageItem(ListItem):
    DEFAULT_CSS = """
    MessageItem {
        height: auto;
        background: transparent;
        padding: 0;
    }
    MessageItem Static {
        width: 1fr;
        background: transparent;
        height: auto;
    }
    """

    def __init__(self, msg: Message) -> None:
        self.msg = msg
        self._selected = False
        self._thinking_expanded = False
        self._text_normal = render_one_message(msg, selected=False)
        self._text_selected = render_one_message(msg, selected=True)
        super().__init__(Static(self._text_normal))

    def set_selected(self, selected: bool) -> None:
        self._selected = selected
        self._refresh()
        bg = theme.SELECTION_BG if selected else "transparent"
        self.styles.background = bg
        self.query_one(Static).styles.background = bg

    def toggle_thinking(self) -> None:
        has_thinking = any(b.kind == "thinking" for b in self.msg.blocks)
        if not has_thinking:
            return
        self._thinking_expanded = not self._thinking_expanded
        self._text_normal = render_one_message(
            self.msg,
            selected=False,
            thinking_expanded=self._thinking_expanded,
        )
        self._text_selected = render_one_message(
            self.msg,
            selected=True,
            thinking_expanded=self._thinking_expanded,
        )
        self._refresh()

    def _refresh(self) -> None:
        self.query_one(Static).update(self._text_selected if self._selected else self._text_normal)
