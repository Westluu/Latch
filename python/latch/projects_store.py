from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field


@dataclass
class WorkspaceInfo:
    name: str
    path: str
    kind: str
    branch: str | None
    is_default: bool
    last_opened_at: str | None


@dataclass
class ProjectInfo:
    alias: str
    root_path: str
    path: str
    created_at: str
    updated_at: str
    last_opened_at: str | None
    default_workspace: str = "default"
    workspaces: list[WorkspaceInfo] = field(default_factory=list)


def _live_git_branch(path: str) -> tuple[bool, str | None]:
    try:
        result = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=path,
            capture_output=True,
            text=True,
        )
    except OSError:
        return False, None
    if result.returncode != 0:
        return False, None
    branch = result.stdout.strip()
    return True, branch or None


def current_workspace_branch(path: str, fallback: str | None = None) -> str | None:
    available, branch = _live_git_branch(path)
    return branch if available else fallback


def list_local_branches(path: str) -> list[str]:
    try:
        result = subprocess.run(
            ["git", "for-each-ref", "--format=%(refname:short)", "--sort=refname", "refs/heads"],
            cwd=path,
            capture_output=True,
            text=True,
        )
    except OSError:
        return []
    if result.returncode != 0:
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def get_projects_config_path() -> str:
    base_dir = os.environ.get("XDG_CONFIG_HOME")
    if base_dir:
        return os.path.join(os.path.abspath(base_dir), "latch", "projects.json")
    return os.path.join(os.path.expanduser("~"), ".config", "latch", "projects.json")


def load_projects() -> list[ProjectInfo]:
    config_path = get_projects_config_path()
    if not os.path.exists(config_path):
        return []

    with open(config_path) as f:
        data = json.load(f)

    version = data.get("version", 1)
    projects = data.get("projects", {})
    items: list[ProjectInfo] = []
    for alias, project in projects.items():
        if not isinstance(project, dict):
            continue

        created_at = project.get("createdAt")
        updated_at = project.get("updatedAt")
        if not isinstance(created_at, str) or not isinstance(updated_at, str):
            continue

        if version >= 2:
            default_workspace = project.get("defaultWorkspace", "default")
            workspaces = project.get("workspaces", {})
            workspace = workspaces.get(default_workspace)
            if not isinstance(workspace, dict):
                continue
            project_path = workspace.get("path")
            root_path = project.get("rootPath", project_path)
            last_opened_at = project.get("lastOpenedAt")
            workspace_items: list[WorkspaceInfo] = []
            for workspace_name, workspace_info in sorted(workspaces.items()):
                if not isinstance(workspace_info, dict):
                    continue
                workspace_path = workspace_info.get("path")
                if not isinstance(workspace_path, str):
                    continue
                stored_branch = workspace_info.get("branch")
                workspace_items.append(
                    WorkspaceInfo(
                        name=workspace_name,
                        path=workspace_path,
                        kind=workspace_info.get("kind", "worktree"),
                        branch=current_workspace_branch(
                            workspace_path,
                            stored_branch if isinstance(stored_branch, str) or stored_branch is None else None,
                        ),
                        is_default=workspace_name == default_workspace,
                        last_opened_at=workspace_info.get("lastOpenedAt"),
                    )
                )
        else:
            project_path = project.get("path")
            root_path = project_path
            last_opened_at = project.get("lastOpenedAt")
            default_workspace = "default"
            if not isinstance(project_path, str):
                continue
            workspace_items = [
                WorkspaceInfo(
                    name=default_workspace,
                    path=project_path,
                    kind="root",
                    branch=None,
                    is_default=True,
                    last_opened_at=last_opened_at,
                )
            ]

        if not isinstance(project_path, str):
            continue

        items.append(
            ProjectInfo(
                alias=alias,
                root_path=root_path,
                path=project_path,
                created_at=created_at,
                updated_at=updated_at,
                last_opened_at=last_opened_at,
                default_workspace=default_workspace,
                workspaces=workspace_items,
            )
        )
    items.sort(key=lambda project: project.alias.lower())
    return items
