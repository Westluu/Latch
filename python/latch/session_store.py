from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from latch.claude_paths import claude_project_paths, find_transcript_path


PLANS_DIR = os.path.join(os.path.expanduser("~"), ".claude", "plans")

_TS_RE = re.compile(r'"timestamp"\s*:\s*"([^"]+)"')
_TAG_RE = re.compile(r"<[^>]+>")


@dataclass
class ContentBlock:
    kind: str
    text: str = ""
    tool_name: str = ""
    tool_file: str = ""
    token_count: int = 0
    is_error: bool = False


@dataclass
class Message:
    role: str
    timestamp: Optional[datetime] = None
    model: str = ""
    tokens_in: int = 0
    tokens_out: int = 0
    blocks: list[ContentBlock] = field(default_factory=list)


@dataclass
class SessionInfo:
    session_id: str
    label: str
    timestamp: Optional[datetime] = None
    started_at: Optional[datetime] = None
    duration_secs: int = 0
    file_size: int = 0
    path: str = ""


def list_sessions(cwd: str) -> list[SessionInfo]:
    sessions_by_id: dict[str, SessionInfo] = {}
    for project_path in claude_project_paths(cwd):
        if not os.path.isdir(project_path):
            continue
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

                    ts_match = _TS_RE.search(tline)
                    if ts_match:
                        timestamp = _parse_ts(ts_match.group(1))
                        if timestamp:
                            if first_ts is None:
                                first_ts = timestamp
                            last_ts = timestamp

                    if not label:
                        try:
                            obj = json.loads(tline)
                        except Exception:
                            continue
                        if (
                            obj.get("type") == "user"
                            and obj.get("isSidechain") is False
                            and not obj.get("isMeta")
                        ):
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

            session = SessionInfo(
                session_id=sid,
                label=label,
                timestamp=ts,
                started_at=first_ts,
                duration_secs=duration,
                file_size=size,
                path=fpath,
            )
            existing = sessions_by_id.get(sid)
            existing_ts = existing.timestamp if existing else None
            session_ts = session.timestamp
            if existing is None or (
                session_ts is not None and (existing_ts is None or session_ts >= existing_ts)
            ):
                sessions_by_id[sid] = session

    sessions = list(sessions_by_id.values())
    sessions.sort(
        key=lambda session: session.timestamp or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )
    return sessions


def parse_messages(cwd: str, session_id: str) -> list[Message]:
    transcript = find_transcript_path(cwd, session_id)
    if not transcript:
        return []

    try:
        with open(transcript) as f:
            lines = f.readlines()
    except Exception:
        return []

    messages: list[Message] = []
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

            if isinstance(content, list):
                for block in content:
                    if block.get("type") != "tool_result":
                        continue
                    tool_id = block.get("tool_use_id", "")
                    if tool_id not in pending_tool_uses:
                        continue
                    message_index, block_index = pending_tool_uses.pop(tool_id)
                    if block.get("is_error"):
                        messages[message_index].blocks[block_index].is_error = True
                    raw_content = block.get("content", "")
                    if isinstance(raw_content, str):
                        raw = raw_content
                    elif isinstance(raw_content, list):
                        raw = " ".join(
                            child.get("text", "")
                            for child in raw_content
                            if child.get("type") == "text"
                        )
                    else:
                        raw = ""
                    preview = _first_meaningful_line(raw)
                    if preview:
                        messages[message_index].blocks[block_index].text = preview

            text = _extract_text(obj)
            if text:
                ts = _parse_ts(obj.get("timestamp"))
                messages.append(
                    Message(role="user", timestamp=ts, blocks=[ContentBlock(kind="text", text=text)])
                )

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
                block_type = block.get("type")
                if block_type == "text" and isinstance(block.get("text"), str):
                    blocks.append(ContentBlock(kind="text", text=block["text"]))
                elif block_type == "thinking":
                    thinking_text = block.get("thinking", "")
                    token_count = len(thinking_text.split()) if thinking_text else 0
                    blocks.append(
                        ContentBlock(
                            kind="thinking",
                            text=thinking_text,
                            token_count=token_count,
                        )
                    )
                elif block_type == "tool_use":
                    tool_input = block.get("input", {})
                    tool_file = (
                        tool_input.get("file_path")
                        or tool_input.get("command")
                        or tool_input.get("pattern")
                        or ""
                    )
                    if isinstance(tool_file, str):
                        tool_file = " ".join(tool_file.split())
                        if len(tool_file) > 80:
                            tool_file = tool_file[:77] + "..."
                    tool_id = block.get("id", "")
                    block_idx = len(blocks)
                    content_block = ContentBlock(
                        kind="tool_use",
                        tool_name=block.get("name", ""),
                        tool_file=str(tool_file),
                        is_error=False,
                    )
                    blocks.append(content_block)
                    if tool_id:
                        pending_tool_uses[tool_id] = (msg_idx, block_idx)

            if blocks:
                messages.append(
                    Message(
                        role="assistant",
                        timestamp=ts,
                        model=model,
                        tokens_in=tokens_in,
                        tokens_out=tokens_out,
                        blocks=blocks,
                    )
                )

    return messages


def get_session_plan_path(cwd: str, session_id: str) -> Optional[str]:
    if not session_id:
        return None
    transcript = find_transcript_path(cwd, session_id)
    if not transcript:
        return None
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
                slug = obj.get("slug")
                if slug:
                    return os.path.join(PLANS_DIR, f"{slug}.md")
    except Exception:
        pass
    return None


def read_plan(plan_path: str) -> str:
    try:
        with open(plan_path) as f:
            return f.read()
    except Exception:
        return "*Could not read plan file.*"


def _first_meaningful_line(text: str, max_len: int = 100) -> str:
    structural = {"{", "[", "}", "]", "```"}
    for line in text.splitlines():
        stripped = line.strip()
        if stripped and stripped not in structural:
            return stripped[: max_len - 3] + "..." if len(stripped) > max_len else stripped
    return ""


def _strip_tags(text: str) -> str:
    return _TAG_RE.sub("", text).strip()


def _extract_text(obj: dict) -> str:
    msg = obj.get("message", {})
    content = msg.get("content", "")
    if isinstance(content, str):
        return _strip_tags(content)
    if isinstance(content, list):
        raw = "\n".join(
            block.get("text", "") for block in content if block.get("type") == "text"
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
