from __future__ import annotations

import os
import re


CLAUDE_DIR = os.path.join(os.path.expanduser("~"), ".claude")
PROJECTS_DIR = os.path.join(CLAUDE_DIR, "projects")

_INVALID_PROJECT_DIR_CHARS_RE = re.compile(r"[^A-Za-z0-9-]")


def claude_project_dir_name(cwd: str) -> str:
    return _INVALID_PROJECT_DIR_CHARS_RE.sub("-", cwd)


def _legacy_claude_project_dir_name(cwd: str) -> str:
    return cwd.replace("/", "-")


def claude_project_paths(cwd: str) -> list[str]:
    names = [claude_project_dir_name(cwd), _legacy_claude_project_dir_name(cwd)]
    deduped_names = list(dict.fromkeys(names))
    return [os.path.join(PROJECTS_DIR, name) for name in deduped_names]


def find_transcript_path(cwd: str, session_id: str) -> str | None:
    for project_path in claude_project_paths(cwd):
        transcript = os.path.join(project_path, f"{session_id}.jsonl")
        if os.path.exists(transcript):
            return transcript
    return None
