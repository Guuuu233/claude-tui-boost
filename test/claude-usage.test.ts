import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHooks } from "../src/index.mjs";
import { createManagedHooks } from "../src/managed-runtime.mjs";
import { parseClaudeUsage, readClaudeUsage } from "../src/claude-usage.mjs";

test("parses Claude Code's session and weekly usage windows", () => {
  const result = parseClaudeUsage([
    "Current session: 37% used · resets Oct 16 at 10:30pm (Asia/Taipei)",
    "Current week (all models): 82% used · resets Oct 19 at 4pm (UTC)",
    "Current week (Opus): 12.5% used",
  ].join("\n"), new Date("2026-10-16T12:00:00Z"));

  expect(result.windows.map(({ name, used, span }) => ({ name, used, span }))).toEqual([
    { name: "5 hours", used: 37, span: 5 * 60 * 60 },
    { name: "7 days", used: 82, span: 7 * 24 * 60 * 60 },
    { name: "7 days · Opus", used: 12.5, span: 7 * 24 * 60 * 60 },
  ]);
  expect(result.windows[0].resetsAt).toBe("2026-10-16T14:30:00.000Z");
});

test("refuses output without a readable quota instead of inventing zero usage", () => {
  expect(() => parseClaudeUsage("You are currently using your subscription to power your Claude Code usage"))
    .toThrow(/allowance data|unavailable/i);
  expect(() => parseClaudeUsage("not logged in"))
    .toThrow(/signed in/i);
});

test("runs only local Claude /usage with the selected profile and strips API-token environment", async () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-usage-test-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const claude = join(bin, "claude");
  writeFileSync(claude, `#!/bin/sh
if [ "$1" != "-p" ] || [ "$2" != "/usage" ]; then exit 80; fi
if [ "$CLAUDE_CONFIG_DIR" != "$HOME/profile" ]; then exit 81; fi
if [ -n "\${ANTHROPIC_AUTH_TOKEN:-}\${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then exit 82; fi
printf '%s\\n' 'Current session: 14% used' 'Current week (all models): 6% used'
`);
  chmodSync(claude, 0o700);

  try {
    const result = await readClaudeUsage({
      profileDir: join(home, "profile"),
      env: {
        HOME: home,
        PATH: bin,
        ANTHROPIC_AUTH_TOKEN: "test-secret-must-not-be-forwarded",
        CLAUDE_CODE_OAUTH_TOKEN: "test-secret-must-not-be-forwarded",
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.windows.map(window => window.used)).toEqual([14, 6]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("exposes usage through the explicit provider auth hook", async () => {
  const profile = "/srv/magpie/claude-profile";
  const hooks = createHooks({
    runtimeURL: "http://127.0.0.1:42123/v1/",
    models: { opus: { name: "Opus" } },
    claudeConfigDir: profile,
    usageReader: async options => ({ windows: [{ name: "5 hours", used: 9, span: 18000 }], profileDir: options.profileDir }),
  });

  expect(typeof hooks.auth.usage).toBe("function");
  await expect(hooks.auth.usage(async () => ({ type: "api", key: "public-local-runtime-key" })))
    .resolves.toMatchObject({ windows: [{ name: "5 hours", used: 9 }], profileDir: profile });
});

test("managed usage reads the profile encoded for that specific account", async () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-managed-usage-test-"));
  const profile = join(home, "gtt-profile");
  mkdirSync(profile);
  let selectedProfile;
  const hooks = createManagedHooks({
    input: { directory: home },
    env: { HOME: home, PATH: process.env.PATH ?? "" },
    usageReader: async options => {
      selectedProfile = options.profileDir;
      return { windows: [{ name: "7 days", used: 23, span: 604800 }] };
    },
  });
  const key = "mgtui1." + Buffer.from(JSON.stringify({
    v: 1, profile, models: ["opus"], managed: "a".repeat(48), state: join(home, "state"),
  })).toString("base64url");

  try {
    expect(typeof hooks.auth.usage).toBe("function");
    const result = await hooks.auth.usage(async () => ({ type: "api", key }));
    expect(selectedProfile).toBe(realpathSync(profile));
    expect(result.windows[0].used).toBe(23);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
