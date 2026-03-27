"""
Latch chat popup TUI — conversation viewer for Claude Code sessions.

Launched via `tmux display-popup` so it floats over all panes.

Usage:
    python3 chat.py <cwd> [session_id]
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import textwrap
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import Footer, Header, Input, ListItem, ListView, Static


# ── Constants ────────────────────────────────────────────────────────────────

CLAUDE_DIR = os.path.join(os.path.expanduser("~"), ".claude")
PROJECTS_DIR = os.path.join(CLAUDE_DIR, "projects")

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

MODEL_COLORS = {
    "opus": ("#C084FC", "#3B1F5B"),
    "sonnet": ("#86EFAC", "#14532D"),
    "haiku": ("#93C5FD", "#1E3A5F"),
}

# Regex to extract timestamp without full JSON parse
_TS_RE = re.compile(r'"timestamp"\s*:\s*"([^"]+)"')
_TAG_RE = re.compile(r"<[^>]+>")


# ── Data model ───────────────────────────────────────────────────────────────

@dataclass
class ContentBlock:
    kind: str  # "text", "thinking", "tool_use", "tool_result"
    text: str = ""
    tool_name: str = ""
    tool_file: str = ""
    tool_id: str = ""
    token_count: int = 0
    is_error: bool = False


@dataclass
class Message:
    role: str  # "user" or "assistant"
    timestamp: Optional[datetime] = None
    model: str = ""
    tokens_in: int = 0
    tokens_out: int = 0
    blocks: list[ContentBlock] = field(default_factory=list)


@dataclass
class SessionInfo:
    session_id: str
    label: str
    timestamp: Optional[datetime] = None  # UpdatedAt (last message)
    started_at: Optional[datetime] = None  # first message
    duration_secs: int = 0
    file_size: int = 0
    path: str = ""


# ── Parsing ──────────────────────────────────────────────────────────────────

def list_sessions(cwd: str) -> list[SessionInfo]:
    """List all Claude sessions for this project directory."""
    project_dir = cwd.replace("/", "-")
    project_path = os.path.join(PROJECTS_DIR, project_dir)
    if not os.path.isdir(project_path):
        return []

    sessions = []
    for fname in os.listdir(project_path):
        if not fname.endswith(".jsonl"):
            continue
        fpath = os.path.join(project_path, fname)
        sid = fname.replace(".jsonl", "")
        size = os.path.getsize(fpath)
        label = ""
        first_ts = None
        last_ts = None

        try:
            with open(fpath) as f:
                lines = f.readlines()

            for tline in lines:
                tline = tline.strip()
                if not tline:
                    continue

                # Extract timestamp via regex — avoids full JSON parse for every line
                ts_match = _TS_RE.search(tline)
                if ts_match:
                    t = _parse_ts(ts_match.group(1))
                    if t:
                        if first_ts is None:
                            first_ts = t
                        last_ts = t

                # Only JSON-parse until we have the label
                if not label:
                    try:
                        obj = json.loads(tline)
                    except Exception:
                        continue
                    if (obj.get("type") == "user"
                            and obj.get("isSidechain") is False
                            and not obj.get("isMeta")):
                        text = _extract_text(obj)
                        first_line = text.split("\n")[0].strip() if text else ""
                        if first_line:
                            label = first_line[:50]

        except Exception:
            pass

        if not label:
            label = sid[:12]

        ts = last_ts
        if not ts:
            try:
                ts = datetime.fromtimestamp(os.path.getmtime(fpath), tz=timezone.utc)
            except Exception:
                pass

        duration = 0
        if first_ts and last_ts and last_ts > first_ts:
            duration = int((last_ts - first_ts).total_seconds())

        sessions.append(SessionInfo(
            session_id=sid, label=label, timestamp=ts,
            started_at=first_ts, duration_secs=duration,
            file_size=size, path=fpath,
        ))

    sessions.sort(key=lambda s: s.timestamp or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return sessions


def search_session_content(path: str, query: str) -> bool:
    """Check if any user/assistant message text in a session contains the query."""
    query_lower = query.lower()
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                obj_type = obj.get("type")
                if obj_type not in ("user", "assistant"):
                    continue
                msg = obj.get("message", {})
                content = msg.get("content", "")
                if isinstance(content, str):
                    if query_lower in content.lower():
                        return True
                elif isinstance(content, list):
                    for block in content:
                        text = block.get("text", "") or block.get("thinking", "")
                        if text and query_lower in text.lower():
                            return True
    except Exception:
        pass
    return False


def parse_messages(cwd: str, session_id: str) -> list[Message]:
    """Parse all messages from a session transcript in a single pass."""
    project_dir = cwd.replace("/", "-")
    transcript = os.path.join(PROJECTS_DIR, project_dir, f"{session_id}.jsonl")
    if not os.path.exists(transcript):
        return []

    try:
        with open(transcript) as f:
            lines = f.readlines()
    except Exception:
        return []

    messages: list[Message] = []
    # Maps tool_use id -> (message_index, block_index) for error annotation
    pending_tool_uses: dict[str, tuple[int, int]] = {}

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue

        obj_type = obj.get("type")

        if obj_type == "user" and obj.get("isSidechain") is False and not obj.get("isMeta"):
            msg_obj = obj.get("message", {})
            content = msg_obj.get("content", "")

            # Annotate pending tool_use blocks with error status + output preview
            if isinstance(content, list):
                for block in content:
                    if block.get("type") == "tool_result":
                        tid = block.get("tool_use_id", "")
                        if tid not in pending_tool_uses:
                            continue
                        mi, bi = pending_tool_uses.pop(tid)
                        if block.get("is_error"):
                            messages[mi].blocks[bi].is_error = True
                        # Store first meaningful output line for preview
                        rc = block.get("content", "")
                        raw = rc if isinstance(rc, str) else " ".join(
                            b.get("text", "") for b in rc if b.get("type") == "text"
                        ) if isinstance(rc, list) else ""
                        preview = _first_meaningful_line(raw)
                        if preview:
                            messages[mi].blocks[bi].text = preview

            text = _extract_text(obj)
            if text:
                ts = _parse_ts(obj.get("timestamp"))
                messages.append(Message(role="user", timestamp=ts, blocks=[
                    ContentBlock(kind="text", text=text)
                ]))

        elif obj_type == "assistant":
            msg_obj = obj.get("message", {})
            content = msg_obj.get("content", [])
            if not isinstance(content, list):
                continue

            model = msg_obj.get("model", "")
            usage = msg_obj.get("usage", {})
            tokens_in = usage.get("input_tokens", 0) or 0
            tokens_out = usage.get("output_tokens", 0) or 0
            ts = _parse_ts(obj.get("timestamp"))

            blocks: list[ContentBlock] = []
            msg_idx = len(messages)

            for block in content:
                bt = block.get("type")
                if bt == "text" and isinstance(block.get("text"), str):
                    blocks.append(ContentBlock(kind="text", text=block["text"]))
                elif bt == "thinking":
                    thinking_text = block.get("thinking", "")
                    tc = len(thinking_text.split()) if thinking_text else 0
                    blocks.append(ContentBlock(
                        kind="thinking", text=thinking_text, token_count=tc,
                    ))
                elif bt == "tool_use":
                    inp = block.get("input", {})
                    tool_file = inp.get("file_path") or inp.get("command") or inp.get("pattern") or ""
                    if isinstance(tool_file, str):
                        # Collapse newlines/tabs so multi-line commands render on one line
                        tool_file = " ".join(tool_file.split())
                        if len(tool_file) > 80:
                            tool_file = tool_file[:77] + "..."
                    tid = block.get("id", "")
                    block_idx = len(blocks)
                    cb = ContentBlock(
                        kind="tool_use", tool_name=block.get("name", ""),
                        tool_file=str(tool_file), tool_id=tid, is_error=False,
                    )
                    blocks.append(cb)
                    if tid:
                        pending_tool_uses[tid] = (msg_idx, block_idx)

            if blocks:
                messages.append(Message(
                    role="assistant", timestamp=ts, model=model,
                    tokens_in=tokens_in, tokens_out=tokens_out, blocks=blocks,
                ))

    return messages


def _first_meaningful_line(text: str, max_len: int = 100) -> str:
    """Extract the first non-empty, non-JSON-structural line from tool output."""
    structural = {"{", "[", "}", "]", "```"}
    for line in text.splitlines():
        t = line.strip()
        if t and t not in structural:
            return t[:max_len - 3] + "..." if len(t) > max_len else t
    return ""


def _strip_tags(text: str) -> str:
    """Remove XML/HTML tags from text."""
    return _TAG_RE.sub("", text).strip()


def _extract_text(obj: dict) -> str:
    msg = obj.get("message", {})
    content = msg.get("content", "")
    if isinstance(content, str):
        return _strip_tags(content)
    if isinstance(content, list):
        raw = "\n".join(
            b.get("text", "") for b in content if b.get("type") == "text"
        ).strip()
        return _strip_tags(raw)
    return ""


def _parse_ts(raw: object) -> Optional[datetime]:
    if not isinstance(raw, str):
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except Exception:
        return None


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
            text.append(part[2:-2], style="bold #F9FAFB")
        elif part.startswith("*") and part.endswith("*") and len(part) > 2:
            text.append(part[1:-1], style="italic #E5E7EB")
        elif part.startswith("`") and part.endswith("`") and len(part) > 2:
            text.append(part[1:-1], style="#F97316")
        else:
            text.append(part)


def _wrap_inline(
    text: Text,
    content: str,
    first_prefix: str,
    cont_prefix: str,
    wrap_w: int,
    prefix_style: str = "#6B7280",
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
            text.append(f"{indent}  {raw}\n", style="#D1D5DB on #1F2937")
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
            text.append(f"{indent}{'─' * 24}\n", style="#374151")
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
        text.append("> ", style="bold #F59E0B")
    else:
        text.append("  ")

    if msg.role == "user":
        text.append(ts_str, style="#6B7280")
        text.append("you", style="bold #10B981")
        text.append("\n")
        # Blank line between header and content (matches sidecar)
        if msg.blocks:
            text.append("\n")
    else:
        text.append(ts_str, style="#6B7280")
        text.append("claude", style="bold #3B82F6")
        ms = model_short(msg.model)
        if ms:
            text.append(" ")  # single space before badge (matches sidecar)
            fg, bg = MODEL_COLORS.get(ms, ("#93C5FD", "#1E3A5F"))
            text.append(f" {ms} ", style=f"{fg} on {bg}")
        if msg.tokens_in or msg.tokens_out:
            text.append(
                f" in:{format_k(msg.tokens_in)} out:{format_k(msg.tokens_out)}",
                style="#6B7280",
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
                text.append("  \u25c8 ", style="italic #C084FC")
                text.append(f"thinking ({tc} tokens) \u25bc", style="italic #C084FC")
                text.append("  [enter to collapse]\n", style="#4B5563")
                term_w = shutil.get_terminal_size((120, 40)).columns
                wrap_w = max(40, int(term_w * 0.68) - 10)
                for tline in block.text.splitlines():
                    if tline.strip():
                        wrapped = textwrap.fill(tline, width=wrap_w,
                                                initial_indent="    ",
                                                subsequent_indent="    ")
                        text.append(wrapped + "\n", style="#9CA3AF")
                    else:
                        text.append("\n")
            else:
                preview = " ".join(block.text.split())
                if len(preview) > 80:
                    preview = preview[:77] + "..."
                text.append("  \u25c8 ", style="italic #C084FC")
                text.append(f"thinking ({tc} tokens) \u25b6", style="italic #C084FC")
                if preview:
                    text.append(f" {preview}", style="#6B7280")
                text.append("\n")
        elif block.kind == "tool_use":
            icon = TOOL_ICONS.get(block.tool_name, "\u2699")
            if block.is_error:
                text.append("  \u2717 ", style="#EF4444")
                text.append(f"{block.tool_name}", style="#EF4444")
            else:
                text.append(f"  {icon} ", style="#6B7280")
                text.append(f"{block.tool_name}", style="#93C5FD")
            if block.tool_file:
                text.append(f": {block.tool_file}", style="#6B7280")
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
                text.append(wrapped + "\n", style="#6B7280")

    text.append("\n")  # spacing between messages
    return text


def render_session_header(session: SessionInfo, messages: list[Message]) -> Text:
    """Render the session header with stats."""
    text = Text()

    # Line 1: icon + label (no indent, matches sidecar)
    text.append("\u25c6 ", style="#F59E0B")
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
    pipe = (" \u2502 ", "#4B5563")
    first = True

    if model:
        fg, bg = MODEL_COLORS.get(model, ("#93C5FD", "#1E3A5F"))
        text.append(f" {model} ", style=f"{fg} on {bg}")
        first = False

    if not first:
        text.append(*pipe)
    text.append(f"{msg_count} msgs", style="#6B7280")

    text.append(*pipe)
    text.append(f"in:{format_k(total_in)} out:{format_k(total_out)}", style="#6B7280")

    if session.timestamp:
        text.append(*pipe)
        text.append(session.timestamp.astimezone().strftime("%b %d %H:%M"), style="#6B7280")

    text.append("\n")

    # Line 3: resume command + [Y:copy] hint (matches sidecar)
    text.append("claude --resume ", style="#93C5FD")
    text.append(session.session_id, style="#93C5FD")
    text.append("  ", style="")
    text.append("[Y:copy]", style="#4B5563")
    text.append("\n")

    # Separator line — 20 chars matches sidecar's min(contentWidth/3, 20)
    text.append("\u2500" * 20 + "\n\n", style="#374151")

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
            parts.append(f"[#6B7280]{dur}[/]")
        if size:
            parts.append(f"[#4B5563]{size}[/]")
        stats = "  " + "  ".join(parts) if parts else ""
        super().__init__(Static(f"[#F59E0B]\u25c6[/] {label}{stats}"))


class GroupHeader(ListItem):
    def __init__(self, label: str) -> None:
        markup = f"[bold #F59E0B]{label}[/]" if label else ""
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
        background: #1F2937;
        color: #F59E0B;
    }
    """

    def __init__(self) -> None:
        super().__init__(Static("[#6B7280]─── [bold]↑ load older messages[/bold] (enter) ───[/]"))


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
        self.styles.color = "#374151"
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
        bg = "#374151" if selected else "transparent"
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
    background: #111827;
}

#left-panel {
    width: 30%;
    border: round #4B5563;
    padding: 0 1;
}

#left-panel:focus-within {
    border: round #7C3AED;
}

#search-input {
    height: 1;
    border: none;
    background: #1F2937;
    color: #F9FAFB;
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
    width: 70%;
    border: round #4B5563;
    padding: 0;
}

#right-panel:focus-within {
    border: round #7C3AED;
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
    color: #4B5563;
    padding: 1 2;
}

ListView > ListItem {
    padding: 0;
    background: transparent;
    color: #9CA3AF;
    width: 1fr;
}
"""


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
                    s.styles.color = "#9CA3AF"
                except Exception:
                    pass
            if isinstance(event.item, SessionListItem):
                try:
                    s = event.item.query_one(Static)
                    s.styles.background = "#374151"
                    s.styles.color = "#F9FAFB"
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
        print("Usage: python3 chat.py <cwd> [session_id] [claude_pane]", file=sys.stderr)
        sys.exit(1)

    cwd = os.path.abspath(sys.argv[1])
    session_id = sys.argv[2] if len(sys.argv) > 2 else ""
    claude_pane = sys.argv[3] if len(sys.argv) > 3 else ""

    if not os.path.isdir(cwd):
        print(f"Error: {cwd!r} is not a directory", file=sys.stderr)
        sys.exit(1)

    app = ChatApp(cwd, session_id, claude_pane)
    app.run()
