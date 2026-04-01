from __future__ import annotations

import json
import os
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
                workspace_items.append(
                    WorkspaceInfo(
                        name=workspace_name,
                        path=workspace_path,
                        kind=workspace_info.get("kind", "worktree"),
                        branch=workspace_info.get("branch"),
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
                created_at=project["createdAt"],
                updated_at=project["updatedAt"],
                last_opened_at=last_opened_at,
                default_workspace=default_workspace,
                workspaces=workspace_items,
            )
        )
    items.sort(key=lambda project: project.alias.lower())
    return items
