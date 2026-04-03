import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "latch-tmux-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function paneStateFile(tmpRoot: string, hashKey: string, suffix: string): string {
  const hash = createHash("sha256").update(hashKey).digest("hex").slice(0, 12);
  return join(tmpRoot, "latch", `${hash}-${suffix}.txt`);
}

test("killLatchPanes closes the workspaces pane with sidecar and tray", () => {
  withTempDir((dir) => {
    const binDir = join(dir, "bin");
    const tmpRoot = join(dir, "tmp");
    const tmuxLog = join(dir, "tmux.log");
    const cwd = join(dir, "repo");
    const sessionId = "session-123";

    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(tmpRoot, "latch"), { recursive: true });
    mkdirSync(cwd, { recursive: true });

    const tmuxStub = join(binDir, "tmux");
    writeFileSync(
      tmuxStub,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LATCH_TMUX_LOG\"\nexit 0\n"
    );
    chmodSync(tmuxStub, 0o755);

    writeFileSync(paneStateFile(tmpRoot, `${cwd}:${sessionId}`, "sidecar-pane"), "%sidecar\n");
    writeFileSync(paneStateFile(tmpRoot, cwd + sessionId, "tray-pane"), "%tray\n");
    writeFileSync(paneStateFile(tmpRoot, `${cwd}:workspaces`, "workspaces-pane"), "%projects\n");
    writeFileSync(paneStateFile(tmpRoot, `${cwd}:project-target`, "project-target-pane"), "%claude\n");
    writeFileSync(paneStateFile(tmpRoot, `${cwd}:${sessionId}:sidecar-target`, "sidecar-target-pane"), "%claude\n");

    const tmuxModulePath = fileURLToPath(new URL("./tmux.js", import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { killLatchPanes } from ${JSON.stringify(tmuxModulePath)}; killLatchPanes(${JSON.stringify(cwd)}, ${JSON.stringify(sessionId)});`,
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          TMPDIR: tmpRoot,
          LATCH_TMUX_LOG: tmuxLog,
        },
        encoding: "utf-8",
      }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);

    const logged = readFileSync(tmuxLog, "utf-8");
    assert.match(logged, /kill-pane -t %sidecar/);
    assert.match(logged, /kill-pane -t %tray/);
    assert.match(logged, /kill-pane -t %projects/);
  });
});
