"""
Latch chat popup TUI — conversation viewer for Claude Code sessions.

Launched via `tmux display-popup` so it floats over all panes.

Usage:
    python3 chat.py <cwd> <session_id>
"""

from __future__ import annotations

import json
import os
import sys

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, VerticalScroll
from textual.widgets import Footer, Header, ListItem, ListView, Markdown, Static


# ── Transcript parsing ───────────────────────────────────────────────────────

CLAUDE_DIR = os.path.join(os.path.expanduser("~"), ".claude")
PROJECTS_DIR = os.path.join(CLAUDE_DIR, "projects")


def parse_conversation(cwd: str, session_id: str) -> list[dict]:
    """Parse conversation messages from a Claude Code JSONL transcript."""
    project_dir = cwd.replace("/", "-")
    transcript = os.path.join(PROJECTS_DIR, project_dir, f"{session_id}.jsonl")
    if not os.path.exists(transcript):
        return []

    messages = []
    try:
        with open(transcript) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue

                if obj.get("type") == "user" and obj.get("isSidechain") is False:
                    text = _extract_text(obj)
                    if text:
                        messages.append({"role": "user", "content": text})
                elif obj.get("type") == "assistant":
                    msg = obj.get("message", {})
                    content = msg.get("content", [])
                    if not isinstance(content, list):
                        continue
                    text_parts = []
                    tools = []
                    for block in content:
                        if block.get("type") == "text" and isinstance(block.get("text"), str):
                            text_parts.append(block["text"])
                        elif block.get("type") == "tool_use":
                            inp = block.get("input", {})
                            tools.append({
                                "name": block.get("name", ""),
                                "file": inp.get("file_path") or inp.get("command") or "",
                            })
                    text = "\n".join(text_parts).strip()
                    if text or tools:
                        entry: dict = {"role": "assistant", "content": text}
                        if tools:
                            entry["tools"] = tools
                        messages.append(entry)
    except Exception:
        pass
    return messages


def _extract_text(obj: dict) -> str:
    msg = obj.get("message", {})
    content = msg.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            b.get("text", "") for b in content if b.get("type") == "text"
        ).strip()
    return ""


# ── Widgets ──────────────────────────────────────────────────────────────────


class TurnListItem(ListItem):
    def __init__(self, turn_index: int, label: str) -> None:
        self.turn_index = turn_index
        display = label if len(label) <= 26 else label[:23] + "..."
        markup = f"[#3B82F6]>[/] {display}"
        super().__init__(Static(markup))


# ── Main App ─────────────────────────────────────────────────────────────────

CSS = """
Screen {
    background: #111827;
}

#turn-list {
    width: 28%;
    border: round #4B5563;
    padding: 0 1;
}

#turn-list:focus-within {
    border: round #7C3AED;
}

#chat-view {
    width: 72%;
    border: round #4B5563;
    overflow-y: scroll;
    padding: 0 1;
}

#chat-view:focus-within {
    border: round #7C3AED;
}

#chat-view Markdown {
    background: transparent;
}

#chat-empty {
    color: #4B5563;
    padding: 1 2;
}

ListView > ListItem {
    padding: 0 1;
    background: transparent;
}

ListView > ListItem.--highlight {
    background: #374151;
}
"""


class ChatApp(App):
    CSS = CSS

    BINDINGS = [
        Binding("q", "quit", "Quit"),
        Binding("escape", "quit", "Quit"),
        Binding("j", "cursor_down", "Down"),
        Binding("k", "cursor_up", "Up"),
        Binding("tab", "focus_next", "Switch pane"),
        Binding("r", "refresh", "Refresh"),
    ]

    def __init__(self, cwd: str, session_id: str) -> None:
        super().__init__()
        self.cwd = cwd
        self.session_id = session_id
        self._conversation: list[dict] = []
        self._turns: list[dict] = []

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Horizontal():
            yield ListView(id="turn-list")
            with VerticalScroll(id="chat-view"):
                yield Markdown("", id="chat-markdown")
                yield Static("No conversation yet.", id="chat-empty")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "LATCH CHAT"
        self._load_conversation()

    def _load_conversation(self) -> None:
        self._conversation = parse_conversation(self.cwd, self.session_id)
        self._rebuild_turns()
        self._render_full_chat()

    def _rebuild_turns(self) -> None:
        self._turns = []
        for i, msg in enumerate(self._conversation):
            if msg.get("role") == "user":
                label = msg.get("content", "")
                first_line = label.split("\n")[0].strip() if label else "(empty)"
                self._turns.append({"index": i, "label": first_line})

        turn_list = self.query_one("#turn-list", ListView)
        turn_list.clear()
        for t_idx, turn in enumerate(self._turns):
            turn_list.append(TurnListItem(t_idx, turn["label"]))

        has_msgs = len(self._conversation) > 0
        self.query_one("#chat-empty").display = not has_msgs
        self.query_one("#chat-markdown").display = has_msgs

    def _render_full_chat(self) -> None:
        if not self._conversation:
            return
        parts: list[str] = []
        for msg in self._conversation:
            role = msg.get("role", "")
            content = msg.get("content", "")
            tools = msg.get("tools", [])

            if role == "user":
                parts.append(f"---\n\n**You**\n\n{content}")
            elif role == "assistant":
                parts.append(f"---\n\n**Claude**\n\n{content}")
                if tools:
                    tool_lines = []
                    for t in tools:
                        name = t.get("name", "")
                        file = t.get("file", "")
                        if file:
                            tool_lines.append(f"- `{name}` {file}")
                        else:
                            tool_lines.append(f"- `{name}`")
                    parts.append("\n" + "\n".join(tool_lines))

        md = "\n\n".join(parts)
        self.query_one("#chat-markdown", Markdown).update(md)

    def _render_chat_from_turn(self, turn_index: int) -> None:
        if turn_index >= len(self._turns):
            return
        msg_start = self._turns[turn_index]["index"]
        msg_end = len(self._conversation)
        if turn_index + 1 < len(self._turns):
            msg_end = self._turns[turn_index + 1]["index"]

        messages = self._conversation[msg_start:msg_end]
        parts: list[str] = []
        for msg in messages:
            role = msg.get("role", "")
            content = msg.get("content", "")
            tools = msg.get("tools", [])

            if role == "user":
                parts.append(f"**You**\n\n{content}")
            elif role == "assistant":
                parts.append(f"**Claude**\n\n{content}")
                if tools:
                    tool_lines = []
                    for t in tools:
                        name = t.get("name", "")
                        file = t.get("file", "")
                        if file:
                            tool_lines.append(f"- `{name}` {file}")
                        else:
                            tool_lines.append(f"- `{name}`")
                    parts.append("\n" + "\n".join(tool_lines))

        md = "\n\n---\n\n".join(parts)
        self.query_one("#chat-markdown", Markdown).update(md)
        self.sub_title = self._turns[turn_index]["label"]

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        item = event.item
        if isinstance(item, TurnListItem):
            self._render_chat_from_turn(item.turn_index)

    def action_cursor_down(self) -> None:
        self.query_one("#turn-list", ListView).action_cursor_down()

    def action_cursor_up(self) -> None:
        self.query_one("#turn-list", ListView).action_cursor_up()

    def action_refresh(self) -> None:
        self._load_conversation()


# ── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 chat.py <cwd> <session_id>", file=sys.stderr)
        sys.exit(1)

    cwd = os.path.abspath(sys.argv[1])
    session_id = sys.argv[2]

    if not os.path.isdir(cwd):
        print(f"Error: {cwd!r} is not a directory", file=sys.stderr)
        sys.exit(1)

    app = ChatApp(cwd, session_id)
    app.run()
