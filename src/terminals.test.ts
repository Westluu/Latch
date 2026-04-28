import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAppleTerminalBindings,
  getAppleTerminalTargetProfiles,
  removeManagedAppleTerminalBindings,
} from "./terminals/apple-terminal.js";
import { detectTerminal } from "./terminals/detect.js";
import {
  applyIterm2Bindings,
  isExpectedIterm2Binding,
  removeManagedIterm2Bindings,
} from "./terminals/iterm2.js";
import {
  configHasLine,
  removeManagedConfigBinding,
  upsertManagedConfigBinding,
} from "./terminals/shared.js";

test("detectTerminal recognizes supported overrides and terminal envs", () => {
  assert.equal(detectTerminal({ LATCH_TERMINAL: "apple_terminal" }), "apple_terminal");
  assert.equal(detectTerminal({ ITERM_SESSION_ID: "iterm" }), "iterm2");
  assert.equal(detectTerminal({ TERM: "xterm-kitty" }), "kitty");
  assert.equal(detectTerminal({ GHOSTTY_BIN_DIR: "/Applications/Ghostty.app" }), "ghostty");
});

test("managed config helpers are idempotent and preserve manual lines on removal", () => {
  const marker = "# latch-keybinding";
  const line = "keybind = cmd+e=text:\\x1be";

  const added = upsertManagedConfigBinding("custom = keep\n", marker, line);
  const addedTwice = upsertManagedConfigBinding(added, marker, line);
  assert.equal(added, addedTwice);
  assert.match(added, /custom = keep/);
  assert.match(added, /# latch-keybinding\nkeybind = cmd\+e=text:\\x1be/);

  const manual = `${line}\n`;
  assert.equal(upsertManagedConfigBinding(manual, marker, line), manual);
  assert.equal(removeManagedConfigBinding(manual, marker, line), manual);
  assert.equal(configHasLine(manual, line), true);
});

test("applyIterm2Bindings adds managed bindings without overwriting conflicting shortcuts", () => {
  const prefs = {
    GlobalKeyMap: {
      "0x70-0x100000-0x23": {
        Action: 99,
        Text: "existing",
      },
    },
  };

  const result = applyIterm2Bindings(prefs, ["primary", "workspaces", "chat"]);
  const globalKeyMap = result.prefs.GlobalKeyMap as Record<string, unknown>;
  const managed = result.prefs.LatchManagedGlobalKeyMap as Record<string, unknown>;

  assert.deepEqual(result.added.sort(), ["chat", "primary"]);
  assert.deepEqual(result.conflicts, ["workspaces"]);
  assert.equal(isExpectedIterm2Binding(globalKeyMap["0x65-0x100000-0xe"], "e"), true);
  assert.equal(isExpectedIterm2Binding(globalKeyMap["0x73-0x100000-0x1"], "s"), true);
  assert.equal((globalKeyMap["0x70-0x100000-0x23"] as { Text: string }).Text, "existing");
  assert.equal(managed["0x65-0x100000-0xe"], true);
  assert.equal(managed["0x73-0x100000-0x1"], true);
  assert.equal(
    isExpectedIterm2Binding({ Action: 10, Text: "e", Version: 1, Label: "Latch" }, "e"),
    false
  );
});

test("removeManagedIterm2Bindings removes only Latch-managed entries", () => {
  const prefs = {
    GlobalKeyMap: {
      "0x65-0x100000-0xe": { Action: 11, Text: "e", Version: 1, Label: "Latch" },
      "0x70-0x100000-0x23": { Action: 11, Text: "custom" },
    },
    LatchManagedGlobalKeyMap: {
      "0x65-0x100000-0xe": true,
    },
  };

  const cleaned = removeManagedIterm2Bindings(prefs);
  const globalKeyMap = cleaned.GlobalKeyMap as Record<string, unknown>;

  assert.equal(globalKeyMap["0x65-0x100000-0xe"], undefined);
  assert.deepEqual(globalKeyMap["0x70-0x100000-0x23"], { Action: 11, Text: "custom" });
  assert.equal(cleaned.LatchManagedGlobalKeyMap, undefined);
});

test("removeManagedIterm2Bindings removes legacy exact Latch entries without metadata", () => {
  const prefs = {
    GlobalKeyMap: {
      "0x65-0x100000-0xe": { Action: 11, Text: "e", Version: 1, Label: "Latch" },
      "0x70-0x100000-0x23": { Action: 11, Text: "custom" },
      "0x73-0x100000-0x1": { Action: 12, Text: "s" },
    },
  };

  const cleaned = removeManagedIterm2Bindings(prefs);
  const globalKeyMap = cleaned.GlobalKeyMap as Record<string, unknown>;

  assert.equal(globalKeyMap["0x65-0x100000-0xe"], undefined);
  assert.deepEqual(globalKeyMap["0x70-0x100000-0x23"], { Action: 11, Text: "custom" });
  assert.deepEqual(globalKeyMap["0x73-0x100000-0x1"], { Action: 12, Text: "s" });
  assert.equal(cleaned.LatchManagedGlobalKeyMap, undefined);
});

test("apple terminal helpers target default and startup profiles without clobbering conflicts", () => {
  const prefs = {
    "Default Window Settings": "Basic",
    "Startup Window Settings": "Basic",
    "Window Settings": {
      Basic: {
        keyMapBoundKeys: {
          "@0070": "custom",
        },
      },
    },
  };

  assert.deepEqual(getAppleTerminalTargetProfiles(prefs), ["Basic"]);

  const result = applyAppleTerminalBindings(prefs, ["primary", "workspaces", "chat"]);
  const windowSettings = result.prefs["Window Settings"] as Record<string, unknown>;
  const basic = windowSettings.Basic as { keyMapBoundKeys: Record<string, string> };
  const managed = result.prefs.LatchManagedAppleTerminalKeyBindings as Record<string, unknown>;

  assert.deepEqual(result.added.sort(), ["chat", "primary"]);
  assert.deepEqual(result.conflicts, ["workspaces"]);
  assert.equal(basic.keyMapBoundKeys["@0065"], "\\033e");
  assert.equal(basic.keyMapBoundKeys["@0070"], "custom");
  assert.equal(basic.keyMapBoundKeys["@0073"], "\\033s");
  assert.deepEqual(Object.keys(managed), ["Basic"]);
});

test("removeManagedAppleTerminalBindings removes only managed profile shortcuts", () => {
  const prefs = {
    "Window Settings": {
      Basic: {
        keyMapBoundKeys: {
          "@0065": "\\033e",
          "@0070": "custom",
        },
      },
    },
    LatchManagedAppleTerminalKeyBindings: {
      Basic: {
        "@0065": true,
      },
    },
  };

  const cleaned = removeManagedAppleTerminalBindings(prefs);
  const windowSettings = cleaned["Window Settings"] as Record<string, unknown>;
  const basic = windowSettings.Basic as { keyMapBoundKeys: Record<string, string> };

  assert.deepEqual(basic.keyMapBoundKeys, { "@0070": "custom" });
  assert.equal(cleaned.LatchManagedAppleTerminalKeyBindings, undefined);
});
