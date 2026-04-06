import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { chmodSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addCurrentProject,
  addProject,
  addWorkspace,
  createWorktreeWorkspace,
  getProject,
  getProjectPath,
  getProjectsConfigPath,
  listProjects,
  markProjectOpened,
  readProjectsRegistry,
  removeProject,
  removeWorkspace,
  validateProjectAlias,
} from "./projects.js";
import { claudeProjectDirName } from "./claude.js";
import { detectTerminal } from "./terminals/index.js";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "latch-projects-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function configPathFor(baseDir: string): string {
  return join(baseDir, "latch", "projects.json");
}

function projectFixturePath(baseDir: string, name: string): string {
  const path = join(baseDir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function cliPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "cli.js");
}

function runCli(
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  } = {}
) {
  return spawnSync(process.execPath, [cliPath(), ...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf-8",
  });
}

function runGit(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const result = spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf-8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function initGitRepo(repoPath: string): void {
  mkdirSync(repoPath, { recursive: true });
  runGit(["init"], repoPath);
  runGit(["config", "user.name", "Latch Tests"], repoPath);
  runGit(["config", "user.email", "latch@example.com"], repoPath);
  writeFileSync(join(repoPath, "README.md"), "# test\n");
  runGit(["add", "README.md"], repoPath);
  runGit(["commit", "-m", "init"], repoPath);
}

test("getProjectsConfigPath uses XDG_CONFIG_HOME when provided", () => {
  assert.equal(
    getProjectsConfigPath({ XDG_CONFIG_HOME: "/tmp/latch-xdg" }),
    "/tmp/latch-xdg/latch/projects.json"
  );
});

test("getProjectsConfigPath falls back to ~/.config", () => {
  assert.equal(
    getProjectsConfigPath({}),
    join(homedir(), ".config", "latch", "projects.json")
  );
});

test("detectTerminal prefers explicit override", () => {
  assert.equal(
    detectTerminal({ LATCH_TERMINAL: "kitty", TERM_PROGRAM: "ghostty" }),
    "kitty"
  );
});

test("detectTerminal recognizes ghostty-specific environment variables", () => {
  assert.equal(
    detectTerminal({ GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app/Contents/Resources" }),
    "ghostty"
  );
});

test("readProjectsRegistry returns an empty registry when config is missing", () => {
  withTempDir((dir) => {
    const registry = readProjectsRegistry(configPathFor(dir));
    assert.deepEqual(registry, { version: 2, projects: {} });
  });
});

test("readProjectsRegistry migrates v1 config to the v2 project/workspace shape", () => {
  withTempDir((dir) => {
    const configPath = configPathFor(dir);
    const projectPath = projectFixturePath(dir, "frontend");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        projects: {
          frontend: {
            path: projectPath,
            createdAt: "2026-03-31T18:00:00.000Z",
            updatedAt: "2026-03-31T18:00:00.000Z",
            lastOpenedAt: null,
          },
        },
      }, null, 2) + "\n"
    );

    const registry = readProjectsRegistry(configPath);
    const project = registry.projects.frontend;

    assert.equal(registry.version, 2);
    assert.ok(project);
    assert.equal(realpathSync(project.rootPath), realpathSync(projectPath));
    assert.equal(project.defaultWorkspace, "default");
    assert.equal(realpathSync(project.workspaces.default.path), realpathSync(projectPath));
    assert.equal(project.workspaces.default.kind, "root");
  });
});

test("readProjectsRegistry accepts v2 workspaces without explicit branch or workspace lastOpenedAt", () => {
  withTempDir((dir) => {
    const configPath = configPathFor(dir);
    const projectPath = projectFixturePath(dir, "frontend");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 2,
        projects: {
          frontend: {
            rootPath: projectPath,
            createdAt: "2026-03-31T18:00:00.000Z",
            updatedAt: "2026-03-31T18:00:00.000Z",
            lastOpenedAt: null,
            defaultWorkspace: "root",
            workspaces: {
              root: {
                path: projectPath,
                kind: "root",
                createdAt: "2026-03-31T18:00:00.000Z",
                updatedAt: "2026-03-31T18:00:00.000Z",
              },
            },
          },
        },
      }, null, 2) + "\n"
    );

    const registry = readProjectsRegistry(configPath);
    const workspace = registry.projects.frontend.workspaces.root;

    assert.equal(realpathSync(workspace.path), realpathSync(projectPath));
    assert.equal(workspace.kind, "root");
    assert.equal(workspace.branch, null);
    assert.equal(workspace.lastOpenedAt, null);
  });
});

test("readProjectsRegistry prefers a worktree's live branch over stale stored metadata", () => {
  withTempDir((dir) => {
    const repoPath = join(dir, "repo");
    const configPath = configPathFor(dir);
    initGitRepo(repoPath);

    addProject("repo", repoPath, { configPath });
    createWorktreeWorkspace("repo", "feature-one", { configPath });

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    config.projects.repo.workspaces["feature-one"].branch = "stale-branch";
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

    const registry = readProjectsRegistry(configPath);
    assert.equal(registry.projects.repo.workspaces["feature-one"].branch, "feature-one");
  });
});

test("readProjectsRegistry refreshes the root workspace branch after switching branches", () => {
  withTempDir((dir) => {
    const repoPath = join(dir, "repo");
    const configPath = configPathFor(dir);
    initGitRepo(repoPath);

    addProject("repo", repoPath, { configPath });
    runGit(["checkout", "-b", "feature-root"], repoPath);

    const project = getProject("repo", configPath);
    assert.ok(project);
    assert.equal(project.workspaces.default.branch, "feature-root");
  });
});

test("readProjectsRegistry fails clearly for invalid JSON", () => {
  withTempDir((dir) => {
    const configPath = configPathFor(dir);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, "{not-json");

    assert.throws(
      () => readProjectsRegistry(configPath),
      /Failed to read projects config/
    );
  });
});

test("addProject creates the config directory and writes pretty JSON without temp leftovers", () => {
  withTempDir((dir) => {
    const configPath = configPathFor(dir);
    const projectPath = projectFixturePath(dir, "frontend");

    addProject("frontend", projectPath, { configPath });

    assert.ok(existsSync(configPath));
    const fileContent = readFileSync(configPath, "utf-8");
    assert.ok(fileContent.endsWith("\n"));
    assert.deepEqual(readdirSync(dirname(configPath)), ["projects.json"]);
  });
});

test("validateProjectAlias rejects invalid and reserved aliases", () => {
  assert.throws(() => validateProjectAlias(""), /cannot be empty/);
  assert.throws(() => validateProjectAlias("bad alias"), /may only contain/);
  assert.throws(() => validateProjectAlias("chat"), /reserved/);
  assert.throws(() => validateProjectAlias("projects"), /reserved/);
  assert.throws(() => validateProjectAlias("workspaces"), /reserved/);
});

test("addProject normalizes relative paths using cwd", () => {
  withTempDir((dir) => {
    const repoPath = projectFixturePath(dir, "repo");
    const configPath = configPathFor(dir);

    const project = addProject("repo", ".", { cwd: repoPath, configPath });
    assert.equal(getProjectPath(project), realpathSync(repoPath));
  });
});

test("addCurrentProject stores the current directory", () => {
  withTempDir((dir) => {
    const repoPath = projectFixturePath(dir, "backend");
    const configPath = configPathFor(dir);

    const project = addCurrentProject("backend", { cwd: repoPath, configPath });
    assert.equal(getProjectPath(project), realpathSync(repoPath));
  });
});

test("addProject rejects nonexistent paths and files", () => {
  withTempDir((dir) => {
    const configPath = configPathFor(dir);
    const filePath = join(dir, "file.txt");
    writeFileSync(filePath, "hello");

    assert.throws(
      () => addProject("missing", join(dir, "missing"), { configPath }),
      /does not exist/
    );
    assert.throws(
      () => addProject("file", filePath, { configPath }),
      /not a directory/
    );
  });
});

test("addProject rejects duplicate aliases and duplicate paths", () => {
  withTempDir((dir) => {
    const configPath = configPathFor(dir);
    const frontend = projectFixturePath(dir, "frontend");
    const backend = projectFixturePath(dir, "backend");

    addProject("frontend", frontend, { configPath });

    assert.throws(
      () => addProject("frontend", backend, { configPath }),
      /already exists/
    );
    assert.throws(
      () => addProject("frontend-copy", frontend, { configPath }),
      /already saved/
    );
  });
});

test("createWorktreeWorkspace creates a git worktree under the project", () => {
  withTempDir((dir) => {
    const repoPath = join(dir, "repo");
    const configPath = configPathFor(dir);
    initGitRepo(repoPath);

    addProject("repo", repoPath, { configPath });
    const workspace = createWorktreeWorkspace("repo", "feature-one", { configPath });

    assert.ok(existsSync(workspace.path));
    assert.equal(runGit(["branch", "--show-current"], workspace.path), "feature-one");
    assert.equal(workspace.kind, "worktree");
  });
});

test("removeWorkspace removes a worktree workspace from git and config", () => {
  withTempDir((dir) => {
    const repoPath = join(dir, "repo");
    const configPath = configPathFor(dir);
    initGitRepo(repoPath);

    addProject("repo", repoPath, { configPath });
    const workspace = createWorktreeWorkspace("repo", "feature-one", { configPath });
    assert.ok(existsSync(workspace.path));

    const removed = removeWorkspace("repo", "feature-one", { configPath });
    assert.equal(removed.path, workspace.path);
    assert.equal(existsSync(workspace.path), false);

    const project = getProject("repo", configPath);
    assert.ok(project);
    assert.equal(project.workspaces["feature-one"], undefined);
  });
});

test("listProjects sorts aliases alphabetically and removeProject deletes only that alias", () => {
  withTempDir((dir) => {
    const configPath = configPathFor(dir);
    addProject("backend", projectFixturePath(dir, "backend"), { configPath });
    addProject("frontend", projectFixturePath(dir, "frontend"), { configPath });

    assert.deepEqual(
      listProjects(configPath).map(({ alias }) => alias),
      ["backend", "frontend"]
    );

    const removed = removeProject("backend", configPath);
    assert.equal(getProjectPath(removed).endsWith("/backend"), true);
    assert.equal(getProject("backend", configPath), null);
    assert.ok(getProject("frontend", configPath));
  });
});

test("markProjectOpened updates only lastOpenedAt", () => {
  withTempDir((dir) => {
    const configPath = configPathFor(dir);
    addProject("frontend", projectFixturePath(dir, "frontend"), { configPath });

    const before = getProject("frontend", configPath);
    assert.ok(before);
    assert.equal(before.lastOpenedAt, null);

    const after = markProjectOpened("frontend", configPath);
    assert.ok(after.lastOpenedAt);
    assert.equal(after.createdAt, before.createdAt);
    assert.equal(after.updatedAt, before.updatedAt);
  });
});

test("cli project list works for empty and populated registries", () => {
  withTempDir((dir) => {
    const env = { ...process.env, XDG_CONFIG_HOME: dir };

    const empty = runCli(["project", "list"], { env });
    assert.equal(empty.status, 0);
    assert.match(empty.stdout, /No saved projects yet/);

    const repoPath = projectFixturePath(dir, "frontend");
    const add = runCli(["project", "add", repoPath, "frontend"], { env });
    assert.equal(add.status, 0);

    const listed = runCli(["project", "list"], { env });
    assert.equal(listed.status, 0);
    assert.match(listed.stdout, /frontend/);
    assert.match(listed.stdout, new RegExp(repoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

test("cli workspace list shows the default workspace for each project", () => {
  withTempDir((dir) => {
    const env = { ...process.env, XDG_CONFIG_HOME: dir };
    const repoPath = projectFixturePath(dir, "frontend");

    assert.equal(runCli(["project", "add", repoPath, "frontend"], { env }).status, 0);

    const listed = runCli(["workspace", "list"], { env });
    assert.equal(listed.status, 0);
    assert.match(listed.stdout, /frontend/);
    assert.match(listed.stdout, /default\*/);
    assert.match(listed.stdout, new RegExp(repoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

test("cli workspace open --current-session respawns the stored target pane for that workspace", () => {
  withTempDir((dir) => {
    const configHome = join(dir, "config");
    const binDir = join(dir, "bin");
    const tmpRoot = join(dir, "tmp");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(tmpRoot, { recursive: true });

    const tmuxLog = join(dir, "tmux.log");
    const tmuxStub = join(binDir, "tmux");
    writeFileSync(
      tmuxStub,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LATCH_TMUX_LOG\"\nif [ \"$1\" = \"display-message\" ] && [ \"$4\" = '#{pane_id}' ]; then printf '%s\\n' '%%main'; fi\nexit 0\n"
    );
    chmodSync(tmuxStub, 0o755);

    const projectPath = projectFixturePath(dir, "frontend");
    const workspacePath = projectFixturePath(projectPath, ".latch/workspaces/feature-one");
    addProject("frontend", projectPath, { configPath: configPathFor(configHome) });
    addWorkspace("frontend", "feature-one", workspacePath, { configPath: configPathFor(configHome) });

    const repoCwd = realpathSync(process.cwd());
    const targetHash = createHash("sha256").update(`${repoCwd}:project-target`).digest("hex").slice(0, 12);
    const latchTmp = join(tmpRoot, "latch");
    mkdirSync(latchTmp, { recursive: true });
    writeFileSync(join(latchTmp, `${targetHash}-project-target-pane.txt`), "%target");

    const env = {
      ...process.env,
      TMUX: "1",
      TMPDIR: tmpRoot,
      XDG_CONFIG_HOME: configHome,
      TERM_PROGRAM: "",
      GHOSTTY_BIN_DIR: "",
      GHOSTTY_RESOURCES_DIR: "",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      LATCH_TMUX_LOG: tmuxLog,
    };

    const result = runCli(["workspace", "open", "frontend", "feature-one", "--current-session"], { env, cwd: repoCwd });
    assert.equal(result.status, 0);

    const logged = readFileSync(tmuxLog, "utf-8");
    assert.match(logged, /respawn-pane -k -t %target -c /);
    assert.match(logged, new RegExp(realpathSync(workspacePath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

test("cli workspace open --tab opens the named workspace in a new tmux window", () => {
  withTempDir((dir) => {
    const configHome = join(dir, "config");
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });

    const tmuxLog = join(dir, "tmux.log");
    const tmuxStub = join(binDir, "tmux");
    writeFileSync(
      tmuxStub,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LATCH_TMUX_LOG\"\nif [ \"$1\" = \"display-message\" ]; then printf '%s\\n' 'latch-test'; fi\nif [ \"$1\" = \"new-window\" ]; then printf '%s\\n' '@42'; fi\nexit 0\n"
    );
    chmodSync(tmuxStub, 0o755);

    const projectPath = projectFixturePath(dir, "frontend");
    const workspacePath = projectFixturePath(projectPath, ".latch/workspaces/feature-two");
    addProject("frontend", projectPath, { configPath: configPathFor(configHome) });
    addWorkspace("frontend", "feature-two", workspacePath, { configPath: configPathFor(configHome) });

    const env = {
      ...process.env,
      TMUX: "1",
      XDG_CONFIG_HOME: configHome,
      TERM_PROGRAM: "",
      GHOSTTY_BIN_DIR: "",
      GHOSTTY_RESOURCES_DIR: "",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      LATCH_TMUX_LOG: tmuxLog,
    };

    const result = runCli(["workspace", "open", "frontend", "feature-two", "--tab"], { env, cwd: realpathSync(process.cwd()) });
    assert.equal(result.status, 0);

    const logged = readFileSync(tmuxLog, "utf-8");
    assert.match(logged, /latch workspace open frontend feature-two/);
    assert.match(logged, /new-window -P -F #\{window_id\} -t /);
  });
});

test("cli workspace create creates a worktree-backed workspace", () => {
  withTempDir((dir) => {
    const configHome = join(dir, "config");
    const repoPath = join(dir, "repo");
    initGitRepo(repoPath);

    const env = {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
    };

    assert.equal(runCli(["project", "add", repoPath, "repo"], { env }).status, 0);

    const result = runCli(["workspace", "create", "repo", "feature-two"], {
      env,
      cwd: repoPath,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Created workspace "repo\/feature-two"/);

    const project = getProject("repo", configPathFor(configHome));
    assert.ok(project);
    const workspace = project.workspaces["feature-two"];
    assert.ok(workspace);
    assert.equal(runGit(["branch", "--show-current"], workspace.path), "feature-two");
  });
});

test("cli workspace remove deletes a worktree-backed workspace", () => {
  withTempDir((dir) => {
    const configHome = join(dir, "config");
    const repoPath = join(dir, "repo");
    initGitRepo(repoPath);

    const env = {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
    };

    assert.equal(runCli(["project", "add", repoPath, "repo"], { env }).status, 0);
    assert.equal(runCli(["workspace", "create", "repo", "feature-three"], { env, cwd: repoPath }).status, 0);

    const projectBefore = getProject("repo", configPathFor(configHome));
    assert.ok(projectBefore);
    const workspacePath = projectBefore.workspaces["feature-three"]?.path;
    assert.ok(workspacePath);
    assert.ok(existsSync(workspacePath));

    const result = runCli(["workspace", "remove", "repo", "feature-three"], {
      env,
      cwd: repoPath,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Removed workspace "repo\/feature-three"/);
    assert.equal(existsSync(workspacePath), false);

    const projectAfter = getProject("repo", configPathFor(configHome));
    assert.ok(projectAfter);
    assert.equal(projectAfter.workspaces["feature-three"], undefined);
  });
});

test("cli project remove deletes the registry entry", () => {
  withTempDir((dir) => {
    const env = { ...process.env, XDG_CONFIG_HOME: dir };
    const repoPath = projectFixturePath(dir, "backend");

    assert.equal(runCli(["project", "add", repoPath, "backend"], { env }).status, 0);
    assert.equal(runCli(["project", "remove", "backend"], { env }).status, 0);

    const config = readProjectsRegistry(configPathFor(dir));
    assert.deepEqual(config.projects, {});
  });
});

test("cli shorthand opens a saved project with its target cwd and records lastOpenedAt", () => {
  withTempDir((dir) => {
    const configHome = join(dir, "config");
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });

    const tmuxLog = join(dir, "tmux.log");
    const tmuxStub = join(binDir, "tmux");
    writeFileSync(
      tmuxStub,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LATCH_TMUX_LOG\"\nif [ \"$1\" = \"display-message\" ]; then printf '%s\\n' 'latch-test'; fi\nif [ \"$1\" = \"new-window\" ]; then printf '%s\\n' '@42'; fi\nexit 0\n"
    );
    chmodSync(tmuxStub, 0o755);

    const projectPath = projectFixturePath(dir, "frontend");
    addProject("frontend", projectPath, { configPath: configPathFor(configHome) });

    const env = {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      LATCH_TMUX_LOG: tmuxLog,
    };

    const result = runCli(["frontend"], { env });
    assert.equal(result.status, 0);

    const logged = readFileSync(tmuxLog, "utf-8");
    assert.match(
      logged,
      new RegExp(`-c ${realpathSync(projectPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );

    const saved = getProject("frontend", configPathFor(configHome));
    assert.ok(saved?.lastOpenedAt);
  });
});

test("python projects app registers ctrl+t for open in tab", () => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      [
        "import sys",
        "sys.path.insert(0, 'python')",
        "import ui.projects as projects",
        "binding = next(binding for binding in projects.ProjectsApp.BINDINGS if binding.action == 'open_selected_in_tab')",
        "print(binding.key)",
        "print(binding.priority)",
      ].join("; "),
    ],
    {
      cwd: realpathSync(process.cwd()),
      encoding: "utf-8",
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.equal(lines[0], "ctrl+t,t");
  assert.equal(lines[1], "True");
});

test("python projects app resolves cli path from the repo dist directory", () => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      [
        "import os",
        "import sys",
        "sys.path.insert(0, 'python')",
        "import ui.projects as projects",
        "app = projects.ProjectsApp('/tmp')",
        "print(os.path.relpath(app._cli_path(), os.getcwd()))",
      ].join("\n"),
    ],
    {
      cwd: realpathSync(process.cwd()),
      encoding: "utf-8",
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "dist/cli.js");
});

test("python projects app open-in-tab action invokes project open --tab", () => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      [
        "import json",
        "import sys",
        "from types import MethodType, SimpleNamespace",
        "sys.path.insert(0, 'python')",
        "import ui.projects as projects",
        "app = projects.ProjectsApp('/tmp')",
        "calls = {}",
        "def run_cli(self, args):",
        "    calls['args'] = args",
        "    return SimpleNamespace(returncode=0, stdout='', stderr='')",
        "def exit_app(self):",
        "    calls['exited'] = True",
        "app._selected_project = MethodType(lambda self: projects.ProjectInfo('frontend', '/tmp/frontend', '/tmp/frontend', '', '', None), app)",
        "app._run_cli = MethodType(run_cli, app)",
        "app.exit = MethodType(exit_app, app)",
        "app.action_open_selected_in_tab()",
        "print(json.dumps(calls, sort_keys=True))",
      ].join("\n"),
    ],
    {
      cwd: realpathSync(process.cwd()),
      encoding: "utf-8",
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout.trim()),
    { args: ["project", "open", "frontend", "--tab"], exited: true }
  );
});

test("python projects app open action invokes project open --current-session", () => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      [
        "import json",
        "import sys",
        "from types import MethodType, SimpleNamespace",
        "sys.path.insert(0, 'python')",
        "import ui.projects as projects",
        "app = projects.ProjectsApp('/tmp')",
        "calls = {}",
        "def run_cli(self, args):",
        "    calls['args'] = args",
        "    return SimpleNamespace(returncode=0, stdout='', stderr='')",
        "def exit_app(self):",
        "    calls['exited'] = True",
        "app._selected_project = MethodType(lambda self: projects.ProjectInfo('frontend', '/tmp/frontend', '/tmp/frontend', '', '', None), app)",
        "app._run_cli = MethodType(run_cli, app)",
        "app.exit = MethodType(exit_app, app)",
        "app.action_open_selected()",
        "print(json.dumps(calls, sort_keys=True))",
      ].join("\n"),
    ],
    {
      cwd: realpathSync(process.cwd()),
      encoding: "utf-8",
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout.trim()),
    { args: ["project", "open", "frontend", "--current-session"], exited: true }
  );
});

test("python load_projects reads v2 projects with multiple workspaces", () => {
  withTempDir((dir) => {
    const configPath = configPathFor(dir);
    const rootPath = projectFixturePath(dir, "frontend");
    const workspacePath = projectFixturePath(rootPath, ".latch/workspaces/feature-one");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 2,
        projects: {
          frontend: {
            rootPath,
            createdAt: "2026-03-31T18:00:00.000Z",
            updatedAt: "2026-03-31T18:00:00.000Z",
            lastOpenedAt: null,
            defaultWorkspace: "root",
            workspaces: {
              root: {
                path: rootPath,
                kind: "root",
                createdAt: "2026-03-31T18:00:00.000Z",
                updatedAt: "2026-03-31T18:00:00.000Z",
              },
              "feature-one": {
                path: workspacePath,
                kind: "worktree",
                branch: "feature-one",
                createdAt: "2026-03-31T18:05:00.000Z",
                updatedAt: "2026-03-31T18:05:00.000Z",
                lastOpenedAt: null,
              },
            },
          },
        },
      }, null, 2) + "\n"
    );

    const result = spawnSync(
      "python3",
      [
        "-c",
        [
          "import json",
          "import os",
          "import sys",
          `os.environ['XDG_CONFIG_HOME'] = ${JSON.stringify(dir)}`,
          "sys.path.insert(0, 'python')",
          "import ui.projects as projects",
          "items = projects.load_projects()",
          "print(json.dumps({'count': len(items), 'alias': items[0].alias, 'workspaces': len(items[0].workspaces), 'default': items[0].default_workspace}, sort_keys=True))",
        ].join("\n"),
      ],
      {
        cwd: realpathSync(process.cwd()),
        encoding: "utf-8",
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout.trim()),
      { alias: "frontend", count: 1, default: "root", workspaces: 2 }
    );
  });
});

test("python load_projects prefers live git branch state over stored branch metadata", () => {
  withTempDir((dir) => {
    const configPath = configPathFor(dir);
    const repoPath = join(dir, "repo");
    initGitRepo(repoPath);
    addProject("repo", repoPath, { configPath });
    runGit(["checkout", "-b", "feature-root"], repoPath);

    const result = spawnSync(
      "python3",
      [
        "-c",
        [
          "import json",
          "import os",
          "import sys",
          `os.environ['XDG_CONFIG_HOME'] = ${JSON.stringify(dir)}`,
          "sys.path.insert(0, 'python')",
          "from latch.projects_store import load_projects",
          "items = load_projects()",
          "default_branch = next(workspace.branch for workspace in items[0].workspaces if workspace.is_default)",
          "print(json.dumps({'alias': items[0].alias, 'branch': default_branch}, sort_keys=True))",
        ].join("\n"),
      ],
      {
        cwd: realpathSync(process.cwd()),
        encoding: "utf-8",
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      alias: "repo",
      branch: "feature-root",
    });
  });
});

test("python load_projects skips malformed project entries instead of failing the whole list", () => {
  withTempDir((dir) => {
    const configPath = configPathFor(dir);
    const validRootPath = projectFixturePath(dir, "frontend");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 2,
        projects: {
          frontend: {
            rootPath: validRootPath,
            createdAt: "2026-03-31T18:00:00.000Z",
            updatedAt: "2026-03-31T18:00:00.000Z",
            lastOpenedAt: null,
            defaultWorkspace: "root",
            workspaces: {
              root: {
                path: validRootPath,
                kind: "root",
                createdAt: "2026-03-31T18:00:00.000Z",
                updatedAt: "2026-03-31T18:00:00.000Z",
              },
            },
          },
          broken: {
            rootPath: projectFixturePath(dir, "broken"),
            createdAt: "2026-03-31T18:00:00.000Z",
            defaultWorkspace: "root",
            workspaces: {
              root: {
                path: projectFixturePath(dir, "broken"),
                kind: "root",
              },
            },
          },
        },
      }, null, 2) + "\n"
    );

    const result = spawnSync(
      "python3",
      [
        "-c",
        [
          "import json",
          "import os",
          "import sys",
          `os.environ['XDG_CONFIG_HOME'] = ${JSON.stringify(dir)}`,
          "sys.path.insert(0, 'python')",
          "import ui.projects as projects",
          "items = projects.load_projects()",
          "print(json.dumps({'count': len(items), 'aliases': [item.alias for item in items]}, sort_keys=True))",
        ].join("\n"),
      ],
      {
        cwd: realpathSync(process.cwd()),
        encoding: "utf-8",
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      aliases: ["frontend"],
      count: 1,
    });
  });
});

test("python projects app passes the selected branch directly when creating a workspace", () => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      [
        "import json",
        "import sys",
        "from types import MethodType, SimpleNamespace",
        "sys.path.insert(0, 'python')",
        "import ui.projects as projects",
        "class FocusTarget:",
        "    def focus(self):",
        "        pass",
        "class StatusTarget:",
        "    def update(self, message):",
        "        pass",
        "app = projects.ProjectsApp('/tmp')",
        "calls = {}",
        "def run_cli(self, args):",
        "    calls['args'] = args",
        "    return SimpleNamespace(returncode=0, stdout='', stderr='')",
        "def query_one(self, selector, *_args, **_kwargs):",
        "    if selector == '#projects-list':",
        "        return FocusTarget()",
        "    if selector == '#status':",
        "        return StatusTarget()",
        "    raise AssertionError(selector)",
        "app._run_cli = MethodType(run_cli, app)",
        "app._refresh_projects = MethodType(lambda self: None, app)",
        "app._sync_list = MethodType(lambda self, **kwargs: None, app)",
        "app.query_one = MethodType(query_one, app)",
        "app._submit_add_worktree('frontend', 'feature-two', 'release/1.0')",
        "print(json.dumps(calls, sort_keys=True))",
      ].join("\n"),
    ],
    {
      cwd: realpathSync(process.cwd()),
      encoding: "utf-8",
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout.trim()),
    { args: ["workspace", "create", "frontend", "feature-two", "release/1.0"] }
  );
});

test("python add worktree modal loads local branch suggestions and defaults to the current branch", () => {
  withTempDir((dir) => {
    const repoPath = join(dir, "repo");
    initGitRepo(repoPath);
    runGit(["checkout", "-b", "feature-root"], repoPath);
    runGit(["branch", "release/1.0"], repoPath);

    const result = spawnSync(
      "python3",
      [
        "-c",
        [
          "import json",
          "import sys",
          "sys.path.insert(0, 'python')",
          "from latch.projects_store import ProjectInfo, WorkspaceInfo",
          "from ui.projects_modal import AddWorktreeModal",
          `repo_path = ${JSON.stringify(repoPath)}`,
          "project = ProjectInfo(",
          "    'repo',",
          "    repo_path,",
          "    repo_path,",
          "    '',",
          "    '',",
          "    None,",
          "    'default',",
          "    [WorkspaceInfo('default', repo_path, 'root', 'feature-root', True, None)],",
          ")",
          "modal = AddWorktreeModal(project)",
          "print(json.dumps({'branch': modal._branch_name, 'suggestions': modal._branch_suggestions}, sort_keys=True))",
        ].join("\n"),
      ],
      {
        cwd: realpathSync(process.cwd()),
        encoding: "utf-8",
      }
    );

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout.trim()) as {
      branch: string;
      suggestions: string[];
    };
    assert.equal(parsed.branch, "feature-root");
    assert.equal(parsed.suggestions[0], "feature-root");
    assert.ok(parsed.suggestions.includes("release/1.0"));
  });
});

test("python projects app open action invokes workspace open when viewing workspaces", () => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      [
        "import json",
        "import sys",
        "from types import MethodType, SimpleNamespace",
        "sys.path.insert(0, 'python')",
        "import ui.projects as projects",
        "app = projects.ProjectsApp('/tmp')",
        "calls = {}",
        "def run_cli(self, args):",
        "    calls['args'] = args",
        "    return SimpleNamespace(returncode=0, stdout='', stderr='')",
        "def exit_app(self):",
        "    calls['exited'] = True",
        "workspace = projects.WorkspaceInfo('feature-one', '/tmp/frontend/.latch/workspaces/feature-one', 'worktree', 'feature-one', False, None)",
        "project = projects.ProjectInfo('frontend', '/tmp/frontend', '/tmp/frontend', '', '', None, 'root', [workspace])",
        "app._mode = 'workspaces'",
        "app._projects = [project]",
        "app._active_project_alias = 'frontend'",
        "app._selected_workspace = MethodType(lambda self: workspace, app)",
        "app._run_cli = MethodType(run_cli, app)",
        "app.exit = MethodType(exit_app, app)",
        "app.action_open_selected()",
        "print(json.dumps(calls, sort_keys=True))",
      ].join("\n"),
    ],
    {
      cwd: realpathSync(process.cwd()),
      encoding: "utf-8",
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout.trim()),
    { args: ["workspace", "open", "frontend", "feature-one", "--current-session"], exited: true }
  );
});

test("python projects app delete action invokes workspace remove when viewing workspaces", () => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      [
        "import json",
        "import sys",
        "from types import MethodType, SimpleNamespace",
        "sys.path.insert(0, 'python')",
        "import ui.projects as projects",
        "app = projects.ProjectsApp('/tmp')",
        "calls = {'args': []}",
        "class FocusTarget:",
        "    def focus(self):",
        "        calls['focused'] = True",
        "class StatusTarget:",
        "    def update(self, message):",
        "        calls['status'] = message",
        "def run_cli(self, args):",
        "    calls['args'].append(args)",
        "    return SimpleNamespace(returncode=0, stdout='', stderr='')",
        "def query_one(self, selector, *_args, **_kwargs):",
        "    if selector == '#projects-list':",
        "        return FocusTarget()",
        "    if selector == '#status':",
        "        return StatusTarget()",
        "    raise AssertionError(selector)",
        "workspace = projects.WorkspaceInfo('feature-one', '/tmp/frontend/.latch/workspaces/feature-one', 'worktree', 'feature-one', False, None)",
        "project = projects.ProjectInfo('frontend', '/tmp/frontend', '/tmp/frontend', '', '', None, 'root', [workspace])",
        "app._mode = 'workspaces'",
        "app._projects = [project]",
        "app._workspaces = [workspace]",
        "app._active_project_alias = 'frontend'",
        "app._selected_workspace = MethodType(lambda self: workspace, app)",
        "app._active_project = MethodType(lambda self: project, app)",
        "app._run_cli = MethodType(run_cli, app)",
        "app._refresh_projects = MethodType(lambda self: calls.__setitem__('refreshed', True), app)",
        "app._sync_list = MethodType(lambda self, **kwargs: calls.__setitem__('synced', kwargs), app)",
        "app.query_one = MethodType(query_one, app)",
        "app.action_delete_selected()",
        "first_status = calls.get('status')",
        "app.action_delete_selected()",
        "print(json.dumps({'first_status': first_status, 'args': calls['args'], 'focused': calls.get('focused', False), 'refreshed': calls.get('refreshed', False), 'synced': calls.get('synced')}, sort_keys=True))",
      ].join("\n"),
    ],
    {
      cwd: realpathSync(process.cwd()),
      encoding: "utf-8",
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout.trim()),
    {
      args: [["workspace", "remove", "frontend", "feature-one"]],
      first_status: 'Press `d` again to delete workspace "feature-one".',
      focused: true,
      refreshed: true,
      synced: { clear_status: true },
    }
  );
});

test("cli built-in commands win over project shorthand lookup", () => {
  withTempDir((dir) => {
    const configPath = configPathFor(dir);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        projects: {
          chat: {
            path: projectFixturePath(dir, "chat-project"),
            createdAt: "2026-03-31T18:00:00.000Z",
            updatedAt: "2026-03-31T18:00:00.000Z",
            lastOpenedAt: null,
          },
        },
      }, null, 2) + "\n"
    );

    const result = runCli(["chat"], {
      env: { ...process.env, XDG_CONFIG_HOME: dir },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /latch chat: must be run inside a tmux session/);
  });
});

test("cli projects opens the popup through tmux", () => {
  withTempDir((dir) => {
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });

    const tmuxLog = join(dir, "tmux.log");
    const tmuxStub = join(binDir, "tmux");
    writeFileSync(
      tmuxStub,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LATCH_TMUX_LOG\"\nif [ \"$1\" = \"display-popup\" ]; then exit 0; fi\nexit 0\n"
    );
    chmodSync(tmuxStub, 0o755);

    const env = {
      ...process.env,
      TMUX: "1",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      LATCH_TMUX_LOG: tmuxLog,
    };

    const result = runCli(["projects"], { env });
    assert.equal(result.status, 0);

    const logged = readFileSync(tmuxLog, "utf-8");
    assert.match(logged, /display-popup/);
    assert.match(logged, /python3/);
    assert.match(logged, /projects\.py/);
  });
});

test("cli chat finds Claude sessions in sanitized project directories", () => {
  withTempDir((dir) => {
    const binDir = join(dir, "bin");
    const claudeProjectsDir = join(dir, ".claude", "projects");
    const repoPath = projectFixturePath(join(dir, "workspace"), "open_source");
    const projectPath = join(repoPath, "Latch");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(projectPath, { recursive: true });

    const tmuxLog = join(dir, "tmux.log");
    const tmuxStub = join(binDir, "tmux");
    const pythonStub = join(binDir, "python3");
    writeFileSync(
      tmuxStub,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LATCH_TMUX_LOG\"\nif [ \"$1\" = \"display-message\" ] && [ \"$2\" = \"-p\" ] && [ \"$3\" = '#{pane_id}' ]; then printf '%s\\n' '%claude'; fi\nif [ \"$1\" = \"display-popup\" ]; then exit 0; fi\nexit 0\n"
    );
    chmodSync(tmuxStub, 0o755);
    writeFileSync(pythonStub, "#!/bin/sh\nexit 0\n");
    chmodSync(pythonStub, 0o755);

    const claudeProjectDir = join(claudeProjectsDir, claudeProjectDirName(realpathSync(projectPath)));
    mkdirSync(claudeProjectDir, { recursive: true });
    writeFileSync(join(claudeProjectDir, "older.jsonl"), "{}\n");
    writeFileSync(join(claudeProjectDir, "latest.jsonl"), "{}\n");

    const olderTime = new Date("2026-03-31T18:00:00.000Z");
    const latestTime = new Date("2026-04-01T18:00:00.000Z");
    utimesSync(join(claudeProjectDir, "older.jsonl"), olderTime, olderTime);
    utimesSync(join(claudeProjectDir, "latest.jsonl"), latestTime, latestTime);

    const env = {
      ...process.env,
      HOME: dir,
      TMUX: "1",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      LATCH_TMUX_LOG: tmuxLog,
    };

    const result = runCli(["chat"], { env, cwd: projectPath });
    assert.equal(result.status, 0, result.stderr);

    const logged = readFileSync(tmuxLog, "utf-8");
    assert.match(logged, /display-popup/);
    assert.match(logged, /latest/);
  });
});

test("cli chat ignores newer transcripts from a different cwd in a colliding Claude directory", () => {
  withTempDir((dir) => {
    const binDir = join(dir, "bin");
    const claudeProjectsDir = join(dir, ".claude", "projects");
    const workspaceDir = join(dir, "workspace");
    const targetPath = projectFixturePath(workspaceDir, "a-b");
    const otherPath = projectFixturePath(workspaceDir, "a/b");
    mkdirSync(binDir, { recursive: true });

    const tmuxLog = join(dir, "tmux.log");
    const tmuxStub = join(binDir, "tmux");
    const pythonStub = join(binDir, "python3");
    writeFileSync(
      tmuxStub,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LATCH_TMUX_LOG\"\nif [ \"$1\" = \"display-message\" ] && [ \"$2\" = \"-p\" ] && [ \"$3\" = '#{pane_id}' ]; then printf '%s\\n' '%claude'; fi\nif [ \"$1\" = \"display-popup\" ]; then exit 0; fi\nexit 0\n"
    );
    chmodSync(tmuxStub, 0o755);
    writeFileSync(pythonStub, "#!/bin/sh\nexit 0\n");
    chmodSync(pythonStub, 0o755);

    const collidingDir = join(claudeProjectsDir, claudeProjectDirName(realpathSync(targetPath)));
    mkdirSync(collidingDir, { recursive: true });
    writeFileSync(
      join(collidingDir, "wrong.jsonl"),
      JSON.stringify({ cwd: realpathSync(otherPath) }) + "\n"
    );
    writeFileSync(
      join(collidingDir, "right.jsonl"),
      JSON.stringify({ cwd: realpathSync(targetPath) }) + "\n"
    );

    const wrongTime = new Date("2026-04-01T19:00:00.000Z");
    const rightTime = new Date("2026-04-01T18:00:00.000Z");
    utimesSync(join(collidingDir, "wrong.jsonl"), wrongTime, wrongTime);
    utimesSync(join(collidingDir, "right.jsonl"), rightTime, rightTime);

    const env = {
      ...process.env,
      HOME: dir,
      TMUX: "1",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      LATCH_TMUX_LOG: tmuxLog,
    };

    const result = runCli(["chat"], { env, cwd: targetPath });
    assert.equal(result.status, 0, result.stderr);

    const logged = readFileSync(tmuxLog, "utf-8");
    assert.match(logged, /display-popup/);
    assert.match(logged, /right/);
    assert.doesNotMatch(logged, /wrong/);
  });
});

test("python get_diff includes both staged and unstaged changes for a partially staged file", () => {
  withTempDir((dir) => {
    const repoPath = join(dir, "repo");
    initGitRepo(repoPath);

    const filePath = join(repoPath, "notes.txt");
    writeFileSync(filePath, "alpha\nbeta\n");
    runGit(["add", "notes.txt"], repoPath);
    runGit(["commit", "-m", "add notes"], repoPath);

    writeFileSync(filePath, "ALPHA\nbeta\n");
    runGit(["add", "notes.txt"], repoPath);
    writeFileSync(filePath, "ALPHA\nBETA\n");

    const result = spawnSync(
      "python3",
      [
        "-c",
        [
          "import sys",
          "sys.path.insert(0, 'python')",
          "from latch.git_state import get_diff",
          `print(get_diff(${JSON.stringify(repoPath)}, 'notes.txt'))`,
        ].join("\n"),
      ],
      {
        cwd: realpathSync(process.cwd()),
        encoding: "utf-8",
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /-alpha/);
    assert.match(result.stdout, /\+ALPHA/);
    assert.match(result.stdout, /-beta/);
    assert.match(result.stdout, /\+BETA/);
  });
});

test("python tray revert_from leaves turns unreverted when restore fails", () => {
  withTempDir((dir) => {
    const targetPath = join(dir, "restored", "note.txt");
    const missingBackupPath = join(dir, "missing-backup.txt");

    const result = spawnSync(
      "python3",
      [
        "-c",
        [
          "import json",
          "import sys",
          "from datetime import datetime",
          "sys.path.insert(0, 'python')",
          "import ui.tray as tray",
          `turn = tray.TurnData('turn-1', 'Broken restore', [{'path': ${JSON.stringify(targetPath)}, 'backupFile': ${JSON.stringify(missingBackupPath)}, 'isNew': False}], {'added': 1, 'removed': 0}, datetime.utcnow())`,
          "turns, errors = tray.revert_from([turn], 0)",
          "print(json.dumps({'reverted': turns[0].reverted, 'errors': errors}))",
        ].join("\n"),
      ],
      {
        cwd: realpathSync(process.cwd()),
        encoding: "utf-8",
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      reverted: false,
      errors: ['Broken restore: missing backup for "note.txt"'],
    });
  });
});

test("cli workspaces opens the picker in a left tmux pane", () => {
  withTempDir((dir) => {
    const binDir = join(dir, "bin");
    const tmpRoot = join(dir, "tmp");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(tmpRoot, { recursive: true });

    const tmuxLog = join(dir, "tmux.log");
    const tmuxStub = join(binDir, "tmux");
    writeFileSync(
      tmuxStub,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LATCH_TMUX_LOG\"\nif [ \"$1\" = \"split-window\" ]; then printf '%s\\n' '%42'; fi\nexit 0\n"
    );
    chmodSync(tmuxStub, 0o755);

    const env = {
      ...process.env,
      TMUX: "1",
      TMPDIR: tmpRoot,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      LATCH_TMUX_LOG: tmuxLog,
    };

    const result = runCli(["workspaces"], { env });
    assert.equal(result.status, 0);

    const logged = readFileSync(tmuxLog, "utf-8");
    assert.match(logged, /split-window -h -b -l 30%/);
    assert.match(logged, /projects\.py/);
  });
});

test("cli workspaces opens to the left of the remembered Claude pane across cwd changes", () => {
  withTempDir((dir) => {
    const binDir = join(dir, "bin");
    const tmpRoot = join(dir, "tmp");
    const focusedPaneCwd = projectFixturePath(dir, "other-pane");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(tmpRoot, { recursive: true });

    const tmuxLog = join(dir, "tmux.log");
    const tmuxStub = join(binDir, "tmux");
    writeFileSync(
      tmuxStub,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LATCH_TMUX_LOG\"\nif [ \"$1\" = \"display-message\" ] && [ \"$2\" = \"-p\" ] && [ \"$3\" = '#{pane_id}' ]; then printf '%s\\n' '%other'; fi\nif [ \"$1\" = \"display-message\" ] && [ \"$2\" = \"-p\" ] && [ \"$3\" = '#{window_id}' ]; then printf '%s\\n' '@7'; fi\nif [ \"$1\" = \"display-message\" ] && [ \"$2\" = \"-p\" ] && [ \"$3\" = '#S' ]; then printf '%s\\n' 'latch-test'; fi\nif [ \"$1\" = \"display-message\" ] && [ \"$2\" = \"-t\" ] && [ \"$4\" = \"-p\" ] && [ \"$5\" = '#S' ]; then printf '%s\\n' 'latch-test'; fi\nif [ \"$1\" = \"split-window\" ]; then printf '%s\\n' '%42'; fi\nexit 0\n"
    );
    chmodSync(tmuxStub, 0o755);

    const latchTmp = join(tmpRoot, "latch");
    mkdirSync(latchTmp, { recursive: true });
    const targetHash = createHash("sha256").update(`tmux-window:@7:sidecar-target`).digest("hex").slice(0, 12);
    writeFileSync(join(latchTmp, `${targetHash}-sidecar-target-pane.txt`), "%claude");

    const env = {
      ...process.env,
      TMUX: "1",
      TMPDIR: tmpRoot,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      LATCH_TMUX_LOG: tmuxLog,
    };

    const result = runCli(["workspaces"], { env, cwd: focusedPaneCwd });
    assert.equal(result.status, 0);

    const logged = readFileSync(tmuxLog, "utf-8");
    assert.match(logged, /display-message -p #\{window_id\}/);
    assert.match(logged, /display-message -p #\{pane_id\}/);
    assert.match(logged, /display-message -t %claude -p #S/);
    assert.match(logged, /split-window -h -b -l 30% -P -F #\{pane_id\} -t %claude -c /);
    assert.match(logged, /projects\.py/);
  });
});

test("cli toggle reopens the sidecar to the right of the saved Claude pane", () => {
  withTempDir((dir) => {
    const binDir = join(dir, "bin");
    const tmpRoot = join(dir, "tmp");
    const focusedPaneCwd = projectFixturePath(dir, "other-pane");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(tmpRoot, { recursive: true });

    const tmuxLog = join(dir, "tmux.log");
    const tmuxStub = join(binDir, "tmux");
    writeFileSync(
      tmuxStub,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LATCH_TMUX_LOG\"\nif [ \"$1\" = \"display-message\" ] && [ \"$2\" = \"-p\" ] && [ \"$3\" = '#{pane_id}' ]; then printf '%s\\n' '%other'; fi\nif [ \"$1\" = \"display-message\" ] && [ \"$2\" = \"-p\" ] && [ \"$3\" = '#{window_id}' ]; then printf '%s\\n' '@7'; fi\nif [ \"$1\" = \"display-message\" ] && [ \"$2\" = \"-p\" ] && [ \"$3\" = '#S' ]; then printf '%s\\n' 'latch-test'; fi\nif [ \"$1\" = \"display-message\" ] && [ \"$2\" = \"-t\" ] && [ \"$4\" = \"-p\" ] && [ \"$5\" = '#S' ]; then printf '%s\\n' 'latch-test'; fi\nif [ \"$1\" = \"split-window\" ]; then printf '%s\\n' '%sidecar'; fi\nexit 0\n"
    );
    chmodSync(tmuxStub, 0o755);

    const repoCwd = realpathSync(process.cwd());
    const latchTmp = join(tmpRoot, "latch");
    mkdirSync(latchTmp, { recursive: true });
    const targetHash = createHash("sha256").update(`tmux-window:@7:sidecar-target`).digest("hex").slice(0, 12);
    writeFileSync(join(latchTmp, `${targetHash}-sidecar-target-pane.txt`), "%claude");

    const env = {
      ...process.env,
      TMUX: "1",
      TMPDIR: tmpRoot,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      LATCH_TMUX_LOG: tmuxLog,
    };

    const result = runCli(["toggle"], { env, cwd: focusedPaneCwd });
    assert.equal(result.status, 0);

    const logged = readFileSync(tmuxLog, "utf-8");
    assert.match(logged, /display-message -p #\{pane_id\}/);
    assert.match(logged, /display-message -p #S/);
    assert.match(logged, /display-message -t %claude -p #S/);
    assert.match(logged, /split-window -h -l 40% -P -F #\{pane_id\} -t %claude -c /);
    assert.match(logged, /sidecar\.py/);
  });
});

test("cli project open --popup switches the client to a new tmux session", () => {
  withTempDir((dir) => {
    const configHome = join(dir, "config");
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });

    const tmuxLog = join(dir, "tmux.log");
    const tmuxStub = join(binDir, "tmux");
    writeFileSync(
      tmuxStub,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LATCH_TMUX_LOG\"\nif [ \"$1\" = \"display-message\" ]; then printf '%s\\n' 'latch-test'; fi\nif [ \"$1\" = \"new-window\" ]; then printf '%s\\n' '@42'; fi\nexit 0\n"
    );
    chmodSync(tmuxStub, 0o755);

    const projectPath = projectFixturePath(dir, "frontend");
    addProject("frontend", projectPath, { configPath: configPathFor(configHome) });

    const env = {
      ...process.env,
      TMUX: "1",
      XDG_CONFIG_HOME: configHome,
      TERM_PROGRAM: "",
      GHOSTTY_BIN_DIR: "",
      GHOSTTY_RESOURCES_DIR: "",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      LATCH_TMUX_LOG: tmuxLog,
    };

    const result = runCli(["project", "open", "frontend", "--popup"], { env });
    assert.equal(result.status, 0);

    const logged = readFileSync(tmuxLog, "utf-8");
    assert.match(logged, /new-session -d -s latch-/);
    assert.match(logged, /switch-client -t latch-/);
  });
});

test("cli project open --current-session respawns the stored target pane", () => {
  withTempDir((dir) => {
    const configHome = join(dir, "config");
    const binDir = join(dir, "bin");
    const tmpRoot = join(dir, "tmp");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(tmpRoot, { recursive: true });

    const tmuxLog = join(dir, "tmux.log");
    const tmuxStub = join(binDir, "tmux");
    writeFileSync(
      tmuxStub,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LATCH_TMUX_LOG\"\nif [ \"$1\" = \"display-message\" ] && [ \"$4\" = '#{pane_id}' ]; then printf '%s\\n' '%%main'; fi\nexit 0\n"
    );
    chmodSync(tmuxStub, 0o755);

    const projectPath = projectFixturePath(dir, "frontend");
    addProject("frontend", projectPath, { configPath: configPathFor(configHome) });

    const repoCwd = realpathSync(process.cwd());
    const targetHash = createHash("sha256").update(`${repoCwd}:project-target`).digest("hex").slice(0, 12);
    const latchTmp = join(tmpRoot, "latch");
    mkdirSync(latchTmp, { recursive: true });
    writeFileSync(join(latchTmp, `${targetHash}-project-target-pane.txt`), "%target");

    const env = {
      ...process.env,
      TMUX: "1",
      TMPDIR: tmpRoot,
      XDG_CONFIG_HOME: configHome,
      TERM_PROGRAM: "",
      GHOSTTY_BIN_DIR: "",
      GHOSTTY_RESOURCES_DIR: "",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      LATCH_TMUX_LOG: tmuxLog,
    };

    const result = runCli(["project", "open", "frontend", "--current-session"], { env, cwd: repoCwd });
    assert.equal(result.status, 0);

    const logged = readFileSync(tmuxLog, "utf-8");
    assert.match(logged, /respawn-pane -k -t %target -c /);
    assert.match(logged, /python3 ".*loading\.py" "claude"/);
    assert.match(logged, /select-pane -t %target/);
  });
});

test("cli project open --tab opens the project in a new tmux window", () => {
  withTempDir((dir) => {
    const configHome = join(dir, "config");
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });

    const tmuxLog = join(dir, "tmux.log");
    const tmuxStub = join(binDir, "tmux");
    writeFileSync(
      tmuxStub,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LATCH_TMUX_LOG\"\nif [ \"$1\" = \"display-message\" ]; then printf '%s\\n' 'latch-test'; fi\nif [ \"$1\" = \"new-window\" ]; then printf '%s\\n' '@42'; fi\nexit 0\n"
    );
    chmodSync(tmuxStub, 0o755);

    const projectPath = projectFixturePath(dir, "frontend");
    addProject("frontend", projectPath, { configPath: configPathFor(configHome) });

    const env = {
      ...process.env,
      TMUX: "1",
      XDG_CONFIG_HOME: configHome,
      TERM_PROGRAM: "",
      GHOSTTY_BIN_DIR: "",
      GHOSTTY_RESOURCES_DIR: "",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      LATCH_TMUX_LOG: tmuxLog,
    };

    const result = runCli(["project", "open", "frontend", "--tab"], { env });
    assert.equal(result.status, 0);

    const logged = readFileSync(tmuxLog, "utf-8");
    assert.match(logged, /display-message -p #S/);
    assert.match(logged, /new-window -P -F #\{window_id\} -t /);
    assert.match(logged, /latch frontend/);
    assert.match(logged, /select-window -t /);
  });
});

test("cli project open --tab opens a new Ghostty terminal on macOS", () => {
  withTempDir((dir) => {
    const configHome = join(dir, "config");
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });

    const osaLog = join(dir, "osascript.log");
    const osascriptStub = join(binDir, "osascript");
    writeFileSync(
      osascriptStub,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LATCH_OSASCRIPT_LOG\"\nexit 0\n"
    );
    chmodSync(osascriptStub, 0o755);

    const projectPath = projectFixturePath(dir, "frontend");
    addProject("frontend", projectPath, { configPath: configPathFor(configHome) });

    const env = {
      ...process.env,
      TMUX: "1",
      TERM_PROGRAM: "ghostty",
      XDG_CONFIG_HOME: configHome,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      LATCH_OSASCRIPT_LOG: osaLog,
    };

    const result = runCli(["project", "open", "frontend", "--tab"], { env });
    assert.equal(result.status, 0);

    const logged = readFileSync(osaLog, "utf-8");
    assert.match(logged, /tell application "Ghostty"/);
    assert.match(logged, /set cfg to new surface configuration/);
    assert.match(logged, /set win to front window/);
    assert.match(logged, /set newTab to new tab in win with configuration cfg/);
    assert.match(logged, /set term to focused terminal of newTab/);
    assert.match(logged, /input text "latch 'frontend'" to term/);
    assert.match(logged, /send key "enter" to term/);
  });
});
