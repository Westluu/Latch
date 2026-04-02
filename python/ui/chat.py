"""
Latch chat popup TUI — conversation viewer for Claude Code sessions.

Launched via `tmux display-popup` so it floats over all panes.

Usage:
    python3 ui/chat.py <cwd> [session_id]
"""

from __future__ import annotations

import os
import re
import shutil
import sys
import textwrap
from datetime import datetime, timezone
from typing import Optional

UI_DIR = os.path.dirname(os.path.abspath(__file__))
PYTHON_DIR = os.path.dirname(UI_DIR)
if PYTHON_DIR not in sys.path:
    sys.path.insert(0, PYTHON_DIR)

from latch import theme
from latch.session_store import Message, SessionInfo, list_sessions, parse_messages
from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import Footer, Header, Input, ListItem, ListView, Static


# ── Constants ────────────────────────────────────────────────────────────────

TOOL_ICONS = {
    "Read": "\u25c9",       # ◉
    "Edit": "\u25c8",       # ◈
    "Write": "\u25c7",      # ◇
    "MultiEdit": "\u25c8",  # ◈
    "Bash": "$",
    "Glob": "\u2299",       # ⊙
    "Grep": "\u2299",       # ⊙
    "WebSearch": "\u2299",   # ⊙
    "WebFetch": "\u2299",    # ⊙
    "TodoRead": "\u2610",    # ☐
    "TodoWrite": "\u2610",   # ☐
    "Agent": "\u2192",       # →
    "Skill": "\u2605",       # ★
}

MODEL_COLORS = theme.MODEL_BADGE_COLORS

# ── Formatting helpers ───────────────────────────────────────────────────────

def format_k(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def format_duration(secs: int) -> str:
    """Format session duration like sidecar: 5s, 3m, 1h, 2h30m."""
    if secs <= 0:
        return ""
    if secs < 60:
        return f"{secs}s"
    mins = secs // 60
    if mins < 60:
        return f"{mins}m"
    hours = mins // 60
    remaining_mins = mins % 60
    if remaining_mins == 0:
        return f"{hours}h"
    return f"{hours}h{remaining_mins}m"


def format_size(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def time_group(dt: Optional[datetime]) -> str:
    """Group by calendar day boundary, matching sidecar's getSessionGroup()."""
    if not dt:
        return "Older"
    from datetime import timedelta
    now = datetime.now(tz=timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    yesterday_start = today_start - timedelta(days=1)
    week_start = today_start - timedelta(days=7)
    if dt >= today_start:
        return "Today"
    if dt >= yesterday_start:
        return "Yesterday"
    if dt >= week_start:
        return "This Week"
    return "Older"


def model_short(model: str) -> str:
    m = model.lower()
    if "opus" in m:
        return "opus"
    if "sonnet" in m:
        return "sonnet"
    if "haiku" in m:
        return "haiku"
    return model.split("-")[0] if model else ""


def format_ts(dt: Optional[datetime]) -> str:
    if not dt:
        return ""
    local = dt.astimezone()
    return local.strftime("%H:%M")


# ── Rendering ────────────────────────────────────────────────────────────────

_MD_INLINE = re.compile(r"(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)")


def _append_inline(text: Text, s: str) -> None:
    """Append string with **bold**, *italic*, and `code` styling."""
    for part in _MD_INLINE.split(s):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            text.append(part[2:-2], style=f"bold {theme.TEXT_BRIGHT}")
        elif part.startswith("*") and part.endswith("*") and len(part) > 2:
            text.append(part[1:-1], style=f"italic {theme.TEXT_PRIMARY}")
        elif part.startswith("`") and part.endswith("`") and len(part) > 2:
            text.append(part[1:-1], style=theme.INLINE_CODE)
        else:
            text.append(part)


def _wrap_inline(
    text: Text,
    content: str,
    first_prefix: str,
    cont_prefix: str,
    wrap_w: int,
    prefix_style: str = theme.TEXT_SUBTLE,
) -> None:
    """Word-wrap content with inline markdown styling.
    First line gets first_prefix (styled), continuation lines get cont_prefix."""
    avail_first = max(10, wrap_w - len(first_prefix))
    avail_cont  = max(10, wrap_w - len(cont_prefix))

    words = content.split()
    cur: list[str] = []
    cur_vis = 0
    is_first = True

    def flush() -> None:
        nonlocal is_first, cur_vis
        pfx = first_prefix if is_first else cont_prefix
        sty = prefix_style if is_first else ""
        text.append(pfx, style=sty)
        _append_inline(text, " ".join(cur))
        text.append("\n")
        is_first = False
        cur.clear()
        cur_vis = 0

    for word in words:
        vis = len(re.sub(r"\*\*|`|\*", "", word))
        avail = avail_first if is_first else avail_cont
        if cur and cur_vis + 1 + vis > avail:
            flush()
        else:
            if cur:
                cur_vis += 1
        cur.append(word)
        cur_vis += vis

    if cur:
        flush()


def _append_md(text: Text, content: str, indent: str, wrap_w: int) -> None:
    """Render markdown content into Rich Text with given indent and wrap width."""
    in_code = False
    for line in content.splitlines():
        raw = line.rstrip()

        # Code fence toggle
        if raw.lstrip().startswith("```"):
            in_code = not in_code
            continue

        if in_code:
            text.append(f"{indent}  {raw}\n", style=f"{theme.CODE_BLOCK_FG} on {theme.SURFACE_BG}")
            continue

        # Empty line
        if not raw.strip():
            text.append("\n")
            continue

        # Heading
        m = re.match(r"^(#{1,3}) (.*)", raw)
        if m:
            text.append(indent)
            _append_inline(text, m.group(2))
            text.append("\n")
            continue

        # Horizontal rule
        if re.match(r"^[-*_]{3,}$", raw.strip()):
            text.append(f"{indent}{'─' * 24}\n", style=theme.SELECTION_BG)
            continue

        # Bullet list — continuation aligns with text after "• "
        m = re.match(r"^(\s*)[-*+] (.*)", raw)
        if m:
            extra = "  " * (len(m.group(1)) // 2)
            first_pfx = f"{indent}{extra}  • "
            cont_pfx  = " " * len(first_pfx)
            _wrap_inline(text, m.group(2), first_pfx, cont_pfx, wrap_w)
            continue

        # Numbered list — continuation aligns with text after "N. "
        m = re.match(r"^(\s*)(\d+)\. (.*)", raw)
        if m:
            extra = "  " * (len(m.group(1)) // 2)
            first_pfx = f"{indent}{extra}  {m.group(2)}. "
            cont_pfx  = " " * len(first_pfx)
            _wrap_inline(text, m.group(3), first_pfx, cont_pfx, wrap_w)
            continue

        # Regular paragraph
        _wrap_inline(text, raw, indent, indent, wrap_w, prefix_style="")


def render_one_message(msg: Message, selected: bool = False, thinking_expanded: bool = False) -> Text:
    """Render a single message as Rich Text, with cursor prefix if selected."""
    text = Text()

    ts = format_ts(msg.timestamp)
    ts_str = f"[{ts}] " if ts else ""

    # Cursor prefix
    if selected:
        text.append("> ", style=f"bold {theme.WARNING}")
    else:
        text.append("  ")

    if msg.role == "user":
        text.append(ts_str, style=theme.TEXT_SUBTLE)
        text.append("you", style=f"bold {theme.SUCCESS}")
        text.append("\n")
        # Blank line between header and content (matches sidecar)
        if msg.blocks:
            text.append("\n")
    else:
        text.append(ts_str, style=theme.TEXT_SUBTLE)
        text.append("claude", style=f"bold {theme.INFO_STRONG}")
        ms = model_short(msg.model)
        if ms:
            text.append(" ")  # single space before badge (matches sidecar)
            fg, bg = MODEL_COLORS.get(ms, theme.MODEL_BADGE_FALLBACK)
            text.append(f" {ms} ", style=f"{fg} on {bg}")
        if msg.tokens_in or msg.tokens_out:
            text.append(
                f" in:{format_k(msg.tokens_in)} out:{format_k(msg.tokens_out)}",
                style=theme.TEXT_SUBTLE,
            )
        text.append("\n")

    # Content blocks — 4-space indent for text, 2-space for block items (matches sidecar)
    for block in msg.blocks:
        if block.kind == "text":
            content = textwrap.dedent(block.text).rstrip()
            if msg.role == "user":
                term_w = shutil.get_terminal_size((120, 40)).columns
                wrap_w = max(40, int(term_w * 0.68) - 10)
                for para in content.split("\n\n"):
                    flat = " ".join(ln.strip() for ln in para.splitlines() if ln.strip())
                    if flat:
                        wrapped = textwrap.fill(
                            flat, width=wrap_w,
                            initial_indent="    ",
                            subsequent_indent="    ",
                        )
                        text.append(wrapped + "\n")
            else:
                term_w = shutil.get_terminal_size((120, 40)).columns
                wrap_w = max(40, int(term_w * 0.68) - 10)
                _append_md(text, content, "    ", wrap_w)
        elif block.kind == "thinking":
            tc = format_k(block.token_count) if block.token_count else "?"
            if thinking_expanded:
                text.append("  \u25c8 ", style=f"italic {theme.THINKING}")
                text.append(f"thinking ({tc} tokens) \u25bc", style=f"italic {theme.THINKING}")
                text.append("  [enter to collapse]\n", style=theme.TEXT_FAINT)
                term_w = shutil.get_terminal_size((120, 40)).columns
                wrap_w = max(40, int(term_w * 0.68) - 10)
                for tline in block.text.splitlines():
                    if tline.strip():
                        wrapped = textwrap.fill(tline, width=wrap_w,
                                                initial_indent="    ",
                                                subsequent_indent="    ")
                        text.append(wrapped + "\n", style=theme.TEXT_SOFT)
                    else:
                        text.append("\n")
            else:
                preview = " ".join(block.text.split())
                if len(preview) > 80:
                    preview = preview[:77] + "..."
                text.append("  \u25c8 ", style=f"italic {theme.THINKING}")
                text.append(f"thinking ({tc} tokens) \u25b6", style=f"italic {theme.THINKING}")
                if preview:
                    text.append(f" {preview}", style=theme.TEXT_SUBTLE)
                text.append("\n")
        elif block.kind == "tool_use":
            icon = TOOL_ICONS.get(block.tool_name, "\u2699")
            if block.is_error:
                text.append("  \u2717 ", style=theme.ERROR)
                text.append(f"{block.tool_name}", style=theme.ERROR)
            else:
                text.append(f"  {icon} ", style=theme.TEXT_SUBTLE)
                text.append(f"{block.tool_name}", style=theme.INFO)
            if block.tool_file:
                text.append(f": {block.tool_file}", style=theme.TEXT_SUBTLE)
            text.append("\n")
            # Output preview — wrap with hanging indent so continuation stays aligned
            if block.text:
                term_w = shutil.get_terminal_size((120, 40)).columns
                wrap_w = max(40, int(term_w * 0.68) - 6)
                wrapped = textwrap.fill(
                    block.text, width=wrap_w,
                    initial_indent="    \u2192 ",
                    subsequent_indent="      ",
                )
                text.append(wrapped + "\n", style=theme.TEXT_SUBTLE)

    text.append("\n")  # spacing between messages
    return text


def render_session_header(session: SessionInfo, messages: list[Message]) -> Text:
    """Render the session header with stats."""
    text = Text()

    # Line 1: icon + label (no indent, matches sidecar)
    text.append("\u25c6 ", style=theme.WARNING)
    text.append(session.label, style="bold")
    text.append("\n")

    # Line 2: model badge | N msgs | in:X out:Y | date
    total_in = sum(m.tokens_in for m in messages)
    total_out = sum(m.tokens_out for m in messages)
    msg_count = len(messages)
    model = ""
    for m in messages:
        if m.model:
            model = model_short(m.model)
            break

    # Stats joined with " │ " (single space each side, matches sidecar)
    pipe = (" \u2502 ", theme.TEXT_FAINT)
    first = True

    if model:
        fg, bg = MODEL_COLORS.get(model, theme.MODEL_BADGE_FALLBACK)
        text.append(f" {model} ", style=f"{fg} on {bg}")
        first = False

    if not first:
        text.append(*pipe)
    text.append(f"{msg_count} msgs", style=theme.TEXT_SUBTLE)

    text.append(*pipe)
    text.append(f"in:{format_k(total_in)} out:{format_k(total_out)}", style=theme.TEXT_SUBTLE)

    if session.timestamp:
        text.append(*pipe)
        text.append(session.timestamp.astimezone().strftime("%b %d %H:%M"), style=theme.TEXT_SUBTLE)

    text.append("\n")

    # Line 3: resume command + [Y:copy] hint (matches sidecar)
    text.append("claude --resume ", style=theme.INFO)
    text.append(session.session_id, style=theme.INFO)
    text.append("  ", style="")
    text.append("[Y:copy]", style=theme.TEXT_FAINT)
    text.append("\n")

    # Separator line — 20 chars matches sidecar's min(contentWidth/3, 20)
    text.append("\u2500" * 20 + "\n\n", style=theme.SELECTION_BG)

    return text


# ── Widgets ──────────────────────────────────────────────────────────────────

class SessionListView(ListView):
    """Session list with vim-style j/k navigation."""
    BINDINGS = [
        Binding("j", "cursor_down", "Down", show=False),
        Binding("k", "cursor_up", "Up", show=False),
    ]


class MessageListView(ListView):
    """Message list with vim-style j/k navigation."""
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
        dur = format_duration(session.duration_secs)
        size = format_size(session.file_size)
        parts = []
        if dur:
            parts.append(f"[{theme.TEXT_SUBTLE}]{dur}[/]")
        if size:
            parts.append(f"[{theme.TEXT_FAINT}]{size}[/]")
        stats = "  " + "  ".join(parts) if parts else ""
        super().__init__(Static(f"[{theme.WARNING}]\u25c6[/] {label}{stats}"))


class GroupHeader(ListItem):
    def __init__(self, label: str) -> None:
        markup = f"[bold {theme.WARNING}]{label}[/]" if label else ""
        super().__init__(Static(markup))
        self.disabled = True


PAGE_SIZE = 50


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
    """Non-selectable horizontal rule shown between assistant→user turn transitions."""
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
        # Re-render with new expanded state
        self._text_normal = render_one_message(self.msg, selected=False,
                                               thinking_expanded=self._thinking_expanded)
        self._text_selected = render_one_message(self.msg, selected=True,
                                                 thinking_expanded=self._thinking_expanded)
        self._refresh()

    def _refresh(self) -> None:
        self.query_one(Static).update(
            self._text_selected if self._selected else self._text_normal
        )


# ── Main App ─────────────────────────────────────────────────────────────────

CSS = """
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


class ChatApp(App):
    CSS = CSS

    BINDINGS = [
        Binding("q", "quit", "Quit", priority=False),
        Binding("escape", "quit", "Quit"),
        Binding("tab", "switch_pane", "Switch pane"),
        Binding("r", "refresh", "Refresh", priority=False),
        Binding("slash", "focus_search", "Search", show=False, priority=False),
        Binding("o", "resume_session", "Resume", priority=False),
    ]

    def __init__(self, cwd: str, session_id: str = "", claude_pane: str = "") -> None:
        super().__init__()
        self.cwd = cwd
        self._initial_session_id = session_id
        self._claude_pane = claude_pane
        self._sessions: list[SessionInfo] = []
        self._messages: list[Message] = []
        self._selected_session: Optional[SessionInfo] = None
        self._current_message_item: Optional[MessageItem] = None
        # Track the currently highlighted session item to avoid iterating all items
        self._highlighted_session_item: Optional[SessionListItem] = None
        # Cache parsed messages per session_id to avoid re-parsing on revisit
        self._session_cache: dict[str, list[Message]] = {}
        # Pagination: index into _messages where the current view starts
        self._msg_page_start: int = 0
        # Search state
        self._search_version: int = 0
        self._filtered_sessions: list[SessionInfo] = []
        self._rendering_session_list: bool = False

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Horizontal():
            with Vertical(id="left-panel"):
                yield Input(placeholder="Search sessions… (/)", id="search-input")
                yield SessionListView(id="session-list")
            with Vertical(id="right-panel"):
                yield Static("", id="session-header")
                yield Static("Select a session.", id="msg-empty")
                yield MessageListView(id="message-list")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "LATCH CHAT"
        self._load_sessions()
        # Focus session list on startup, not the search input
        self.query_one("#session-list", SessionListView).focus()

    def _load_sessions(self) -> None:
        self._sessions = list_sessions(self.cwd)
        self._filtered_sessions = self._sessions

        self._render_session_list(self._sessions)

        # Auto-select initial session
        target_session: Optional[SessionInfo] = None
        if self._initial_session_id:
            for s in self._sessions:
                if s.session_id == self._initial_session_id:
                    target_session = s
                    break
        elif self._sessions:
            target_session = self._sessions[0]

        if target_session is not None:
            self._load_session(target_session)

    def _render_session_list(self, sessions: list[SessionInfo], query: str = "") -> None:
        """Render the given sessions into the session list widget."""
        self._rendering_session_list = True
        session_list = self.query_one("#session-list", SessionListView)
        session_list.clear()
        self._highlighted_session_item = None

        # Group sessions by time
        groups: dict[str, list[SessionInfo]] = {}
        for s in sessions:
            g = time_group(s.timestamp)
            groups.setdefault(g, []).append(s)

        count = len(sessions)
        header = f"Results {count}" if query else f"Sessions {count}"
        session_list.append(GroupHeader(header))

        item_index = 1
        first_session_idx: Optional[int] = None
        first_group = True
        for group_name in ["Today", "Yesterday", "This Week", "Older"]:
            if group_name not in groups:
                continue
            if not first_group and group_name in ("Yesterday", "This Week"):
                session_list.append(GroupHeader(""))
                item_index += 1
            first_group = False
            group_sessions = groups[group_name]
            session_list.append(GroupHeader(f"{group_name} ({len(group_sessions)})"))
            item_index += 1
            for s in group_sessions:
                if first_session_idx is None:
                    first_session_idx = item_index
                session_list.append(SessionListItem(s))
                item_index += 1

        if first_session_idx is not None:
            session_list.index = first_session_idx
        self._rendering_session_list = False

    # ── Search ────────────────────────────────────────────────────────────────

    def action_focus_search(self) -> None:
        self.query_one("#search-input", Input).focus()

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id != "search-input":
            return
        self._search_version += 1
        query = event.value.strip()

        if not query:
            self._filtered_sessions = self._sessions
            self._render_session_list(self._sessions)
            return

        # Instant label filter
        query_lower = query.lower()
        label_matches = [s for s in self._sessions if query_lower in s.label.lower()]
        self._filtered_sessions = label_matches
        self._render_session_list(label_matches, query)

    def on_input_submitted(self, event: Input.Submitted) -> None:
        """Move focus to session list when Enter is pressed in search."""
        if event.input.id == "search-input":
            self.query_one("#session-list", SessionListView).focus()

    def action_quit(self) -> None:
        focused = self.focused
        if isinstance(focused, Input) and focused.id == "search-input":
            focused.value = ""
            self.query_one("#session-list", SessionListView).focus()
            return
        self.exit()

    def action_resume_session(self) -> None:
        """Send /resume to the Claude pane and close the chat viewer."""
        if not self._selected_session or not self._claude_pane:
            return
        sid = self._selected_session.session_id
        import subprocess
        subprocess.run(
            ["tmux", "send-keys", "-t", self._claude_pane, f"/resume {sid}", "Enter"],
            capture_output=True,
        )
        self.exit()

    def _load_session(self, session: SessionInfo) -> None:
        self._selected_session = session
        self._current_message_item = None

        # Use cached messages if available
        if session.session_id in self._session_cache:
            self._messages = self._session_cache[session.session_id]
        else:
            self._messages = parse_messages(self.cwd, session.session_id)
            self._session_cache[session.session_id] = self._messages

        header_text = render_session_header(session, self._messages)
        self.query_one("#session-header", Static).update(header_text)

        has_msgs = len(self._messages) > 0
        self.query_one("#msg-empty").display = not has_msgs

        # Start from the last PAGE_SIZE messages
        self._msg_page_start = max(0, len(self._messages) - PAGE_SIZE)
        self._current_message_item = None

        msg_list = self.query_one("#message-list", MessageListView)
        msg_list.clear()
        if has_msgs:
            self._populate_message_list(msg_list)
            msg_list.scroll_end(animate=False)

        self.sub_title = session.label

    def _populate_message_list(self, msg_list: MessageListView) -> None:
        """Render messages from _msg_page_start onward, with a load-more item if there are older ones."""
        if self._msg_page_start > 0:
            msg_list.append(LoadMoreItem())
        prev_role = None
        for msg in self._messages[self._msg_page_start:]:
            if prev_role is not None and prev_role != msg.role:
                msg_list.append(TurnSeparatorItem())
            msg_list.append(MessageItem(msg))
            prev_role = msg.role

    async def _load_more_messages(self) -> None:
        """Prepend the previous PAGE_SIZE messages above the current view."""
        if self._msg_page_start == 0:
            return
        old_start = self._msg_page_start
        self._msg_page_start = max(0, self._msg_page_start - PAGE_SIZE)

        msg_list = self.query_one("#message-list", MessageListView)
        msg_list.index = None

        # Clear the entire list
        await msg_list.clear()

        # Repopulate from the new page start
        self._populate_message_list(msg_list)

        # Find the child index of the first MessageItem that was the old top
        target_idx = 0
        for i, child in enumerate(msg_list.children):
            if isinstance(child, MessageItem):
                if child.msg is self._messages[old_start]:
                    target_idx = i
                    break

        # Set index to that item — ListView's watch_index will scroll to it
        msg_list.index = target_idx

    def on_list_view_highlighted(self, event: ListView.Highlighted) -> None:
        if event.list_view.id == "session-list":
            # Skip highlight updates triggered by search re-rendering
            if self._rendering_session_list:
                return
            # Only update the two affected items instead of all SessionListItems
            if self._highlighted_session_item is not None:
                try:
                    s = self._highlighted_session_item.query_one(Static)
                    s.styles.background = "transparent"
                    s.styles.color = theme.TEXT_SOFT
                except Exception:
                    pass
            if isinstance(event.item, SessionListItem):
                try:
                    s = event.item.query_one(Static)
                    s.styles.background = theme.SELECTION_BG
                    s.styles.color = theme.TEXT_BRIGHT
                except Exception:
                    pass
                self._highlighted_session_item = event.item
                self._load_session(event.item.session)
            else:
                self._highlighted_session_item = None

        elif event.list_view.id == "message-list":
            # Update message cursor
            if self._current_message_item is not None:
                self._current_message_item.set_selected(False)
            # Update load-more highlight
            for child in event.list_view.children:
                if isinstance(child, LoadMoreItem):
                    child.remove_class("-highlight")
            if isinstance(event.item, LoadMoreItem):
                event.item.add_class("-highlight")
            if isinstance(event.item, MessageItem):
                event.item.set_selected(True)
                self._current_message_item = event.item
            else:
                self._current_message_item = None

    async def on_list_view_selected(self, event: ListView.Selected) -> None:
        if event.list_view.id == "session-list" and isinstance(event.item, SessionListItem):
            self._load_session(event.item.session)
            # Focus the message list after selecting a session
            self.query_one("#message-list", MessageListView).focus()
        elif event.list_view.id == "message-list" and isinstance(event.item, LoadMoreItem):
            await self._load_more_messages()
        elif event.list_view.id == "message-list" and isinstance(event.item, MessageItem):
            event.item.toggle_thinking()

    def action_switch_pane(self) -> None:
        session_list = self.query_one("#session-list", SessionListView)
        msg_list = self.query_one("#message-list", MessageListView)
        if session_list.has_focus:
            msg_list.focus()
        else:
            session_list.focus()

    def action_refresh(self) -> None:
        if self._selected_session:
            # Invalidate cache for the current session so fresh data is loaded
            self._session_cache.pop(self._selected_session.session_id, None)
            self._load_session(self._selected_session)


# ── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 ui/chat.py <cwd> [session_id] [claude_pane]", file=sys.stderr)
        sys.exit(1)

    cwd = os.path.abspath(sys.argv[1])
    session_id = sys.argv[2] if len(sys.argv) > 2 else ""
    claude_pane = sys.argv[3] if len(sys.argv) > 3 else ""

    if not os.path.isdir(cwd):
        print(f"Error: {cwd!r} is not a directory", file=sys.stderr)
        sys.exit(1)

    app = ChatApp(cwd, session_id, claude_pane)
    app.run()
