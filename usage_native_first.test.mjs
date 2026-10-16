import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeUsage } from './src/claude-usage.mjs';

function fixture(t) {
  const profile = mkdtempSync(join(tmpdir(), 'magpie-usage-isolated-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  // A synthetic credential present on disk must NOT cause a network request
  // unless a user explicitly chose a direct-usage transport.
  writeFileSync(join(profile, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-token-not-valid' } }));
  return profile;
}

function spawnUsage(log) {
  return (executable, args, options) => {
    log.push({ executable, args, options });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => true;
    queueMicrotask(() => {
      proc.stdout.emit('data', Buffer.from('Current session: 10% used · resets Oct 17 at 3pm (UTC)\nCurrent week (all models): 21% used · resets Oct 19 at 2pm (UTC)\n'));
      proc.emit('close', 0, null);
    });
    return proc;
  };
}

test('default usage follows the native Claude Code CLI even if a profile has an OAuth token', async (t) => {
  const profile = fixture(t);
  const started = [];
  let directRequests = 0;
  const result = await readClaudeUsage({ profileDir: profile, env: { HOME: profile },
    command: '/sandbox/claude', spawnProcess: spawnUsage(started),
    fetchImpl: async () => { directRequests++; throw new Error('direct quota request forbidden in native mode'); } });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.windows.map(x => [x.name, x.used]), [['5 hours', 10], ['7 days', 21]]);
  assert.equal(started.length, 1);
  assert.deepEqual(started[0].args, ['-p', '/usage']);
  assert.equal(started[0].options.env.CLAUDE_CONFIG_DIR, profile);
  assert.equal(directRequests, 0, 'no OAuth access token should be sent directly by default');
});

test('explicit direct mode is separate from native CLI and never silently falls back', async (t) => {
  const profile = fixture(t);
  let cliStarted = 0;
  let directRequests = 0;
  const result = await readClaudeUsage({ profileDir: profile, env: { HOME: profile }, usageMode: 'direct',
    command: '/sandbox/claude', spawnProcess: () => { cliStarted++; throw new Error('CLI must not run'); },
    fetchImpl: async (url, init) => {
      directRequests++;
      assert.match(url, /api\/oauth\/usage$/);
      assert.equal(init.headers.Authorization, 'Bearer synthetic-token-not-valid');
      return new Response(JSON.stringify({ five_hour: { utilization: 15 } }), { status: 200 });
    } });
  assert.equal(result.error, undefined);
  assert.equal(result.windows[0].used, 15);
  assert.equal(directRequests, 1);
  assert.equal(cliStarted, 0);
});

test('native and direct usage caches do not mix for the same Claude profile', async (t) => {
  const profile = fixture(t);
  let nativeStarts = 0;
  let directStarts = 0;
  const native = await readClaudeUsage({ profileDir: profile, env: { HOME: profile },
    command: '/sandbox/claude', spawnProcess: (...args) => { nativeStarts++; return spawnUsage([])(...args); },
    fetchImpl: async () => { throw new Error('no direct network allowed'); } });
  const direct = await readClaudeUsage({ profileDir: profile, env: { HOME: profile }, usageMode: 'direct',
    fetchImpl: async () => {
      directStarts++;
      return new Response(JSON.stringify({ seven_day: { utilization: 63 } }), { status: 200 });
    } });
  assert.equal(native.error, undefined);
  assert.equal(direct.error, undefined);
  assert.equal(native.windows[0].used, 10);
  assert.equal(direct.windows[0].used, 63);
  assert.equal(nativeStarts, 1);
  assert.equal(directStarts, 1);
});
