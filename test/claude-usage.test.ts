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

test("explicit direct quota mode reads selected profile without sending prompt data", async () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-usage-api-test-"));
  const profile = join(home, "profile");
  mkdirSync(profile);
  const accessToken = "access-token-must-not-escape-this-request";
  const refreshToken = "refresh-token-must-never-be-used";
  writeFileSync(join(profile, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken },
  }), { mode: 0o600 });
  let calls = 0;
  let request;
  const fetchImpl = async (url, options) => {
    calls += 1;
    request = { url: String(url), options };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        five_hour: { utilization: 75, resets_at: "2026-10-16T10:40:00Z" },
        seven_day: { utilization: 12, resets_at: "2026-10-18T18:00:00Z" },
        seven_day_sonnet: { utilization: 4.5, resets_at: "2026-10-18T18:00:00Z" },
      }),
    };
  };

  try {
    const options = {
      profileDir: profile,
      usageMode: "direct",
      env: { HOME: home, PATH: "" },
      fetchImpl,
      spawnProcess: () => { throw new Error("Claude CLI should not run when OAuth credentials are available"); },
    };
    const result = await readClaudeUsage(options);

    expect(result.windows).toEqual([
      { name: "5 hours", used: 75, span: 5 * 60 * 60, resetsAt: "2026-10-16T10:40:00.000Z" },
      { name: "7 days", used: 12, span: 7 * 24 * 60 * 60, resetsAt: "2026-10-18T18:00:00.000Z" },
      { name: "7 days · Sonnet", used: 4.5, span: 7 * 24 * 60 * 60, resetsAt: "2026-10-18T18:00:00.000Z" },
    ]);
    expect(request.url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(request.options.method).toBe("GET");
    expect(request.options.body).toBeUndefined();
    expect(request.options.redirect).toBe("error");
    expect(request.options.headers.Authorization).toBe(`Bearer ${accessToken}`);
    expect(request.options.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(JSON.stringify(result)).not.toContain(accessToken);
    expect(JSON.stringify(request.options)).not.toContain(refreshToken);

    await readClaudeUsage(options);
    expect(calls).toBe(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("does not expose OAuth credentials when the official usage endpoint refuses them", async () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-usage-refused-test-"));
  const profile = join(home, "profile");
  mkdirSync(profile);
  const accessToken = "private-access-token";
  writeFileSync(join(profile, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken: "private-refresh-token" },
  }), { mode: 0o600 });

  try {
    const result = await readClaudeUsage({
      profileDir: profile,
      usageMode: "direct",
      env: { HOME: home, PATH: "" },
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: accessToken }),
      }),
    });
    expect(result.windows).toEqual([]);
    expect(result.error).toMatch(/expired|rejected/i);
    expect(result.error).not.toContain(accessToken);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("falls back to the local CLI for profiles whose credentials are not file-backed", async () => {
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
