export type ClaudeLaunchCommandOptions = {
  claudePath: string;
  claudeArgs: string[];
  unsetEnvArgs: string[];
  envArgs: string[];
  exitStatusPath: string;
  holdMs: number;
};

export function interactiveMcpBackgroundEnvArgs(): string[] {
  // tmux servers can predate this wrapper and retain their original environment.
  return [
    "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0",
    // This private MCP server is the only source of client tools. Join its
    // alwaysLoad listing before the first prompt instead of racing startup.
    "CLAUDE_CODE_MCP_ALWAYS_LOAD_JOIN_BEFORE_INPUT=1",
    "CLAUDE_CODE_MCP_STARTUP_WAIT_MS=30000",
  ];
}

/**
 * The Go Runtime decides which side owns automatic compaction. A tmux server
 * can outlive that Runtime and retain a different (or missing) environment.
 * Pass this decision explicitly to the *native Claude* child, not just to the
 * Bun wrapper started by Go.
 */
export function nativeAutoCompactionLaunchEnv(env: NodeJS.ProcessEnv): {
  unsetEnvArgs: string[];
  envArgs: string[];
} {
  if (env.DISABLE_AUTO_COMPACT === "1") {
    return { unsetEnvArgs: [], envArgs: ["DISABLE_AUTO_COMPACT=1"] };
  }
  // Standalone one-shot calls must not inherit a stale tmux server's flag.
  return { unsetEnvArgs: ["-u", "DISABLE_AUTO_COMPACT"], envArgs: [] };
}

export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * tmux runs a one-argument pane command through its `default-shell`
 * (`<default-shell> -c <command>`), and initialises that option from $SHELL
 * or, when $SHELL is unset, from the passwd entry of the account.  A service
 * account whose passwd shell is /usr/sbin/nologin therefore exits before the
 * command starts: `new-session` still returns 0, the pane is gone and a
 * one-session server exits.  Passing multiple arguments takes tmux's
 * execvp() path instead (spawn.c), so name the shell explicitly and never
 * depend on the account's login shell.
 */
export type TmuxNewSessionOptions = {
  sessionName: string;
  cwd: string;
  command: string;
  width?: number;
  height?: number;
};

export function buildTmuxNewSessionArgs(opts: TmuxNewSessionOptions): string[] {
  return [
    "new-session",
    "-d",
    "-s",
    opts.sessionName,
    "-x",
    String(opts.width ?? 220),
    "-y",
    String(opts.height ?? 50),
    "-c",
    opts.cwd,
    "/bin/sh",
    "-c",
    opts.command,
  ];
}

export function buildClaudeLaunchCommand(opts: ClaudeLaunchCommandOptions): string {
  const envCommand = [
    "env",
    ...opts.unsetEnvArgs,
    ...opts.envArgs,
    opts.claudePath,
    ...opts.claudeArgs,
  ]
    .map(shellQuote)
    .join(" ");
  const holdSeconds = Math.max(1, Math.ceil(opts.holdMs / 1000));
  const script = [
    envCommand,
    "status=$?",
    `printf '%s\\n' "$status" > ${shellQuote(opts.exitStatusPath)}`,
    `printf '\\n[claude-bridge] claude exited with status %s\\n' "$status" >&2`,
    `sleep ${holdSeconds}`,
    `exit "$status"`,
  ].join("\n");

  return `/bin/sh -lc ${shellQuote(script)}`;
}
