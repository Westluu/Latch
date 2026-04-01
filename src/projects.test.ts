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
  writeFileSync,
} from "node:fs";
import { chmodSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addCurrentProject,
  addProject,
  getProject,
  getProjectsConfigPath,
  listProjects,
  markProjectOpened,
  readProjectsRegistry,
  removeProject,
  validateProjectAlias,
} from "./projects.js";

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

test("readProjectsRegistry returns an empty registry when config is missing", () => {
  withTempDir((dir) => {
    const registry = readProjectsRegistry(configPathFor(dir));
    assert.deepEqual(registry, { version: 1, projects: {} });
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
    assert.equal(project.path, realpathSync(repoPath));
  });
});

test("addCurrentProject stores the current directory", () => {
  withTempDir((dir) => {
    const repoPath = projectFixturePath(dir, "backend");
    const configPath = configPathFor(dir);

    const project = addCurrentProject("backend", { cwd: repoPath, configPath });
    assert.equal(project.path, realpathSync(repoPath));
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
    assert.equal(removed.path.endsWith("/backend"), true);
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
        "import projects",
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
        "import projects",
        "app = projects.ProjectsApp('/tmp')",
        "calls = {}",
        "def run_cli(self, args):",
        "    calls['args'] = args",
        "    return SimpleNamespace(returncode=0, stdout='', stderr='')",
        "def exit_app(self):",
        "    calls['exited'] = True",
        "app._selected_project = MethodType(lambda self: projects.ProjectInfo('frontend', '/tmp/frontend', '', '', None), app)",
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
        "import projects",
        "app = projects.ProjectsApp('/tmp')",
        "calls = {}",
        "def run_cli(self, args):",
        "    calls['args'] = args",
        "    return SimpleNamespace(returncode=0, stdout='', stderr='')",
        "def exit_app(self):",
        "    calls['exited'] = True",
        "app._selected_project = MethodType(lambda self: projects.ProjectInfo('frontend', '/tmp/frontend', '', '', None), app)",
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
