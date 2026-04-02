from __future__ import annotations

import re
import shutil
import textwrap
from datetime import datetime, timezone
from typing import Optional

from latch import theme
from latch.session_store import Message, SessionInfo
from rich.text import Text


TOOL_ICONS = {
    "Read": "\u25c9",
    "Edit": "\u25c8",
    "Write": "\u25c7",
    "MultiEdit": "\u25c8",
    "Bash": "$",
    "Glob": "\u2299",
    "Grep": "\u2299",
    "WebSearch": "\u2299",
    "WebFetch": "\u2299",
    "TodoRead": "\u2610",
    "TodoWrite": "\u2610",
    "Agent": "\u2192",
    "Skill": "\u2605",
}

MODEL_COLORS = theme.MODEL_BADGE_COLORS
_MD_INLINE = re.compile(r"(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)")


def format_k(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def format_duration(secs: int) -> str:
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


def _wrap_width(offset: int = 10) -> int:
    return max(40, int(shutil.get_terminal_size((120, 40)).columns * 0.68) - offset)


def _append_inline(text: Text, s: str) -> None:
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
    avail_first = max(10, wrap_w - len(first_prefix))
    avail_cont = max(10, wrap_w - len(cont_prefix))

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
    in_code = False
    for line in content.splitlines():
        raw = line.rstrip()

        if raw.lstrip().startswith("```"):
            in_code = not in_code
            continue

        if in_code:
            text.append(f"{indent}  {raw}\n", style=f"{theme.CODE_BLOCK_FG} on {theme.SURFACE_BG}")
            continue

        if not raw.strip():
            text.append("\n")
            continue

        m = re.match(r"^(#{1,3}) (.*)", raw)
        if m:
            text.append(indent)
            _append_inline(text, m.group(2))
            text.append("\n")
            continue

        if re.match(r"^[-*_]{3,}$", raw.strip()):
            text.append(f"{indent}{'─' * 24}\n", style=theme.SELECTION_BG)
            continue

        m = re.match(r"^(\s*)[-*+] (.*)", raw)
        if m:
            extra = "  " * (len(m.group(1)) // 2)
            first_pfx = f"{indent}{extra}  • "
            cont_pfx = " " * len(first_pfx)
            _wrap_inline(text, m.group(2), first_pfx, cont_pfx, wrap_w)
            continue

        m = re.match(r"^(\s*)(\d+)\. (.*)", raw)
        if m:
            extra = "  " * (len(m.group(1)) // 2)
            first_pfx = f"{indent}{extra}  {m.group(2)}. "
            cont_pfx = " " * len(first_pfx)
            _wrap_inline(text, m.group(3), first_pfx, cont_pfx, wrap_w)
            continue

        _wrap_inline(text, raw, indent, indent, wrap_w, prefix_style="")


def render_one_message(msg: Message, selected: bool = False, thinking_expanded: bool = False) -> Text:
    text = Text()

    ts = format_ts(msg.timestamp)
    ts_str = f"[{ts}] " if ts else ""

    if selected:
        text.append("> ", style=f"bold {theme.WARNING}")
    else:
        text.append("  ")

    if msg.role == "user":
        text.append(ts_str, style=theme.TEXT_SUBTLE)
        text.append("you", style=f"bold {theme.SUCCESS}")
        text.append("\n")
        if msg.blocks:
            text.append("\n")
    else:
        text.append(ts_str, style=theme.TEXT_SUBTLE)
        text.append("claude", style=f"bold {theme.INFO_STRONG}")
        ms = model_short(msg.model)
        if ms:
            text.append(" ")
            fg, bg = MODEL_COLORS.get(ms, theme.MODEL_BADGE_FALLBACK)
            text.append(f" {ms} ", style=f"{fg} on {bg}")
        if msg.tokens_in or msg.tokens_out:
            text.append(
                f" in:{format_k(msg.tokens_in)} out:{format_k(msg.tokens_out)}",
                style=theme.TEXT_SUBTLE,
            )
        text.append("\n")

    for block in msg.blocks:
        if block.kind == "text":
            content = textwrap.dedent(block.text).rstrip()
            if msg.role == "user":
                wrap_w = _wrap_width()
                for para in content.split("\n\n"):
                    flat = " ".join(ln.strip() for ln in para.splitlines() if ln.strip())
                    if flat:
                        wrapped = textwrap.fill(
                            flat,
                            width=wrap_w,
                            initial_indent="    ",
                            subsequent_indent="    ",
                        )
                        text.append(wrapped + "\n")
            else:
                _append_md(text, content, "    ", _wrap_width())
        elif block.kind == "thinking":
            tc = format_k(block.token_count) if block.token_count else "?"
            if thinking_expanded:
                text.append("  \u25c8 ", style=f"italic {theme.THINKING}")
                text.append(f"thinking ({tc} tokens) \u25bc", style=f"italic {theme.THINKING}")
                text.append("  [enter to collapse]\n", style=theme.TEXT_FAINT)
                wrap_w = _wrap_width()
                for tline in block.text.splitlines():
                    if tline.strip():
                        wrapped = textwrap.fill(
                            tline,
                            width=wrap_w,
                            initial_indent="    ",
                            subsequent_indent="    ",
                        )
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
            if block.text:
                wrapped = textwrap.fill(
                    block.text,
                    width=_wrap_width(6),
                    initial_indent="    \u2192 ",
                    subsequent_indent="      ",
                )
                text.append(wrapped + "\n", style=theme.TEXT_SUBTLE)

    text.append("\n")
    return text


def render_session_header(session: SessionInfo, messages: list[Message]) -> Text:
    text = Text()

    text.append("\u25c6 ", style=theme.WARNING)
    text.append(session.label, style="bold")
    text.append("\n")

    total_in = sum(m.tokens_in for m in messages)
    total_out = sum(m.tokens_out for m in messages)
    msg_count = len(messages)
    model = ""
    for m in messages:
        if m.model:
            model = model_short(m.model)
            break

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
    text.append("claude --resume ", style=theme.INFO)
    text.append(session.session_id, style=theme.INFO)
    text.append("  ", style="")
    text.append("[Y:copy]", style=theme.TEXT_FAINT)
    text.append("\n")
    text.append("\u2500" * 20 + "\n\n", style=theme.SELECTION_BG)

    return text
