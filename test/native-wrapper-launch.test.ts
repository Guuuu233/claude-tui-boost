import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeLaunchCommand, interactiveMcpBackgroundEnvArgs } from "../vendor/claude-bridge-magpie/src/launch-command.ts";

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
  expect(source).toContain("buildClaudeLaunchCommand({");
  expect(interactiveMcpBackgroundEnvArgs()).toEqual(["CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0"]);
});
