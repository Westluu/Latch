#!/usr/bin/env node
import { isInsideTmux, splitAndLaunchSidecar, launchNewSession } from "./tmux.js";
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
    console.log(`
latch — terminal sidecar for agent workflows

Usage:
  latch              Open sidecar in a tmux pane
  latch --help       Show this help message
  latch --version    Show version
`);
    process.exit(0);
}
if (args.includes("--version") || args.includes("-v")) {
    console.log("latch v0.1.0");
    process.exit(0);
}
const cwd = process.cwd();
if (isInsideTmux()) {
    console.log("latch: opening sidecar pane...");
    const paneId = splitAndLaunchSidecar(cwd);
    console.log(`latch: sidecar running in pane ${paneId}`);
}
else {
    console.log("latch: not inside tmux, creating new session...");
    launchNewSession(cwd);
}
//# sourceMappingURL=cli.js.map