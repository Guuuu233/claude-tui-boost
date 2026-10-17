import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeLaunchCommand, interactiveMcpBackgroundEnvArgs, nativeAutoCompactionLaunchEnv } from "../vendor/claude-bridge-magpie/src/launch-command.ts";

test("real tmux launch command forces plugin-owned MCP callback to remain foreground", () => {
  const root = mkdtempSync(join(tmpdir(), "magpie-wrapper-launch-"));
  try {
    const shim = join(root, "claude");
    const report = join(root, "seen");
    writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "\${CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS:-unset}" > "$1"\n`, {mode:0o700});
    chmodSync(shim, 0o700);
    const cmd = buildClaudeLaunchCommand({
      claudePath: shim, claudeArgs: [report],
      unsetEnvArgs: ["-u", "ANTHROPIC_AUTH_TOKEN"],
      envArgs: interactiveMcpBackgroundEnvArgs(),
      exitStatusPath: join(root, "status"), holdMs: 1,
    });
    const original = process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS;
    const result = Bun.spawnSync(["/bin/sh", "-c", cmd], {
      env: {...process.env, HOME: root, ANTHROPIC_AUTH_TOKEN: "synthetic-only",
        CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "120000"},
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(report, "utf8").trim()).toBe("0");
    expect(readFileSync(join(root, "status"), "utf8").trim()).toBe("0");
    expect(process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS).toBe(original);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("actual vendored Claude wrapper uses the foreground MCP environment builder", () => {
  const source = readFileSync(new URL("../vendor/claude-bridge-magpie/src/cli.ts", import.meta.url), "utf8");
  expect(source).toContain("...interactiveMcpBackgroundEnvArgs()");
  expect(source).toContain("...nativeAutoCompactionLaunchEnv(process.env).envArgs");
  expect(source).toContain("...nativeAutoCompactionLaunchEnv(process.env).unsetEnvArgs");
  expect(source).toContain("buildClaudeLaunchCommand({");
  expect(interactiveMcpBackgroundEnvArgs()).toEqual(["CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0"]);
});

test("real native child receives client-owned auto-compaction setting even with stale tmux environment", () => {
  const root = mkdtempSync(join(tmpdir(), "magpie-native-compact-owner-"));
  try {
    const shim = join(root, "claude");
    writeFileSync(shim, "#!/bin/sh\nprintf '%s\\n' \"${DISABLE_AUTO_COMPACT-unset}\" > \"$1\"\n", {mode: 0o700});
    for (const options of [
      { wrapper: "1", staleTmux: "0", expected: "1" },
      { wrapper: undefined, staleTmux: "1", expected: "unset" },
    ]) {
      const report = join(root, `seen-${options.expected}`);
      const auto = nativeAutoCompactionLaunchEnv({
        ...process.env, DISABLE_AUTO_COMPACT: options.wrapper,
      });
      const cmd = buildClaudeLaunchCommand({
        claudePath: shim, claudeArgs: [report],
        unsetEnvArgs: auto.unsetEnvArgs,
        envArgs: [...interactiveMcpBackgroundEnvArgs(), ...auto.envArgs],
        exitStatusPath: join(root, `status-${options.expected}`), holdMs: 1,
      });
      const result = Bun.spawnSync(["/bin/sh", "-c", cmd], {
        env: { ...process.env, HOME: root, DISABLE_AUTO_COMPACT: options.staleTmux },
      });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(report, "utf8").trim()).toBe(options.expected);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
