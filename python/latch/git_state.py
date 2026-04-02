from __future__ import annotations

import os
import subprocess
from typing import TypedDict

from rich.text import Text


class ChangedFile(TypedDict):
    path: str
    status: str
    label: str


STATUS_LABEL: dict[str, str] = {
    "M": "M",
    "A": "A",
    "D": "D",
    "?": "?",
    "AM": "A",
    "MM": "M",
    "R": "M",
}

STATUS_COLORS: dict[str, str] = {
    "modified": "#F59E0B",
    "added": "#10B981",
    "deleted": "#EF4444",
    "untracked": "#6B7280",
}

STATUS_MAP: dict[str, str] = {
    "M": "modified",
    "A": "added",
    "D": "deleted",
    "?": "untracked",
    "AM": "added",
    "MM": "modified",
    "R": "modified",
}


def get_changed_files(cwd: str) -> list[ChangedFile]:
    result = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=cwd,
        capture_output=True,
        text=True,
    )
    files: list[ChangedFile] = []
    for line in result.stdout.splitlines():
        if not line:
            continue
        xy = line[:2].strip()
        path = line[3:]
        if " -> " in path:
            path = path.split(" -> ")[-1]
        status = STATUS_MAP.get(xy, "modified")
        label = STATUS_LABEL.get(xy, "M")
        files.append({"path": path, "status": status, "label": label})
    return files


def get_diff(cwd: str, file_path: str) -> str:
    for args in [
        ["git", "diff", "--cached", "--", file_path],
        ["git", "diff", "--", file_path],
    ]:
        result = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
        if result.stdout.strip():
            return result.stdout
    full = os.path.join(cwd, file_path)
    if os.path.exists(full):
        try:
            with open(full) as f:
                return "\n".join(f"+ {line.rstrip()}" for line in f)
        except Exception:
            return "(binary or unreadable file)"
    return "(no diff available)"


def render_diff(diff_text: str) -> Text:
    text = Text()
    for line in diff_text.splitlines():
        if line.startswith("+++") or line.startswith("---"):
            text.append(line + "\n", style="#6B7280")
        elif line.startswith("+"):
            text.append(line + "\n", style="#10B981 on #0D2818")
        elif line.startswith("-"):
            text.append(line + "\n", style="#EF4444 on #2D1A1A")
        elif line.startswith("@@"):
            text.append(line + "\n", style="bold #3B82F6")
        else:
            text.append(line + "\n", style="#6B7280")
    return text
