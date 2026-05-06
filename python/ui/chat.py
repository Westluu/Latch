"""
Latch chat popup TUI — conversation viewer for Claude Code sessions.

Launched via `tmux display-popup` so it floats over all panes.

Usage:
    python3 ui/chat.py <cwd> [session_id]
"""

from __future__ import annotations

import os
import sys
from typing import Optional

try:
    from ._runtime import arg_value, bootstrap_python_root, require_directory_arg
except ImportError:
    from _runtime import arg_value, bootstrap_python_root, require_directory_arg

bootstrap_python_root()

from latch import theme
from latch.session_store import Message, SessionInfo, list_sessions, parse_messages
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import Footer, Header, Input, ListView, Static

try:
    from .chat_render import render_session_header, time_group
    from .chat_widgets import (
        CHAT_APP_CSS,
        GroupHeader,
        LoadMoreItem,
        MessageItem,
        MessageListView,
        SessionListItem,
        SessionListView,
        TurnSeparatorItem,
    )
except ImportError:
    from chat_render import render_session_header, time_group
    from chat_widgets import (
        CHAT_APP_CSS,
        GroupHeader,
        LoadMoreItem,
        MessageItem,
        MessageListView,
        SessionListItem,
        SessionListView,
        TurnSeparatorItem,
    )

PAGE_SIZE = 50


class ChatApp(App):
    CSS = CHAT_APP_CSS

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
        self._filtered_sessions: list[SessionInfo] = []
        self._rendering_session_list: bool = False

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Horizontal():
            with Vertical(id="left-panel"):
                yield Input(placeholder="Search sessions or branches… (/)", id="search-input")
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
        query = event.value.strip()

        if not query:
            self._filtered_sessions = self._sessions
            self._render_session_list(self._sessions)
            return

        # Instant label + branch filter
        query_lower = query.lower()
        filtered = [
            s for s in self._sessions
            if query_lower in s.label.lower() or query_lower in (s.branch or "").lower()
        ]
        self._filtered_sessions = filtered
        self._render_session_list(filtered, query)

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
                self._highlighted_session_item.set_selected(False)
            if isinstance(event.item, SessionListItem):
                event.item.set_selected(True)
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
    cwd = require_directory_arg(sys.argv, 1, "Usage: python3 ui/chat.py <cwd> [session_id] [claude_pane]")
    session_id = arg_value(sys.argv, 2)
    claude_pane = arg_value(sys.argv, 3)

    app = ChatApp(cwd, session_id, claude_pane)
    app.run()
