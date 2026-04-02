from __future__ import annotations

import os
import re
from typing import Optional


CLAUDE_DIR = os.path.join(os.path.expanduser("~"), ".claude")
PROJECTS_DIR = os.path.join(CLAUDE_DIR, "projects")

_INVALID_PROJECT_DIR_CHARS_RE = re.compile(r"[^A-Za-z0-9-]")


def claude_project_dir_name(cwd: str) -> str:
    return _INVALID_PROJECT_DIR_CHARS_RE.sub("-", cwd)


def legacy_claude_project_dir_name(cwd: str) -> str:
    return cwd.replace("/", "-")


def claude_project_paths(cwd: str) -> list[str]:
    names = [claude_project_dir_name(cwd), legacy_claude_project_dir_name(cwd)]
    deduped_names = list(dict.fromkeys(names))
    return [os.path.join(PROJECTS_DIR, name) for name in deduped_names]


def _normalize_cwd(path: str) -> str:
    return os.path.normcase(os.path.realpath(path))


def transcript_cwd(transcript_path: str) -> Optional[str]:
    try:
        with open(transcript_path) as f:
            for line in f:
                line = line.strip()
                if not line or '"cwd"' not in line:
                    continue
                match = re.search(r'"cwd"\s*:\s*"([^"]+)"', line)
                if match:
                    return match.group(1)
    except OSError:
        return None
    return None


def transcript_matches_cwd(transcript_path: str, cwd: str) -> bool:
    transcript_root = transcript_cwd(transcript_path)
    if transcript_root is None:
        return True
    return _normalize_cwd(transcript_root) == _normalize_cwd(cwd)


def find_transcript_path(cwd: str, session_id: str) -> str | None:
    for project_path in claude_project_paths(cwd):
        transcript = os.path.join(project_path, f"{session_id}.jsonl")
        if os.path.exists(transcript) and transcript_matches_cwd(transcript, cwd):
            return transcript
    return None
