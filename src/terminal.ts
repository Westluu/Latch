export type SupportedTerminal = "ghostty" | "iterm2" | "kitty" | "apple_terminal" | "unknown";

export function detectTerminal(env: NodeJS.ProcessEnv = process.env): SupportedTerminal {
  const override = (env.LATCH_TERMINAL || "").toLowerCase();
  if (
    override === "ghostty" ||
    override === "iterm2" ||
    override === "kitty" ||
    override === "apple_terminal"
  ) {
    return override;
  }

  if (env.TERM_PROGRAM === "ghostty") return "ghostty";
  if (env.GHOSTTY_BIN_DIR || env.GHOSTTY_RESOURCES_DIR) return "ghostty";

  if (env.TERM_PROGRAM === "iTerm.app" || env.ITERM_SESSION_ID) return "iterm2";
  if (env.TERM_PROGRAM === "Apple_Terminal") return "apple_terminal";

  if (env.KITTY_WINDOW_ID || env.TERM === "xterm-kitty") return "kitty";
  return "unknown";
}
