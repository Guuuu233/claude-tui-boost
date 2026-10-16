/**
 * Fully isolated JS plugin -> signed loopback HTTP -> Go runtime -> FAKE CLI.
 * No Claude executable, live gateway, user profile, key or production port.
 * Usage: MAGPIE_AUDIT_RUNTIME_BINARY=/absolute/path/to/candidate node isolated_http_e2e.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createHooks } from '../src/index.mjs';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const os = process.platform;
const arch = process.arch === 'x64' ? 'amd64' : process.arch;
const exe = join(pluginRoot, 'bin', `magpie-tui-runtime.${os}-${arch}`);

test('bundled signed plugin -> actual isolated Go runtime -> fake Claude stream, without account access', {timeout:30000}, async () => {
assert.ok(existsSync(exe), 'bundled runtime for test platform is missing');
const dir = mkdtempSync(join(tmpdir(), 'magpie-signed-integration-'));
let child;
let stderr = '';
try {
  const home = join(dir, 'home');
  const state = join(dir, 'state');
  const bin = join(dir, 'bin');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  // The Runtime checks for an installed Claude CLI before dispatching to
  // our synthetic bridge. Mac workstations already have one, but Linux CI
  // must remain standalone and MUST NOT run genuine Claude or authenticate.
  const claude = join(bin, 'claude');
  writeFileSync(claude, '#!/bin/sh\nif [ "${1:-}" = "--version" ]; then echo "2.1.296 (offline Claude Code test stub)"; exit 0; fi\necho "refusing real Claude calls" >&2\nexit 93\n', {mode:0o700});
  const bridge = join(dir, 'fake-claude-bridge.sh');
  writeFileSync(bridge, `#!/bin/sh\n# Synthetic transcript only; no Claude Code or network invocation.\ncat >/dev/null\nprintf '%s\\n' '{"type":"assistant","uuid":"u1","session_id":"fake-native-1","message":{"id":"m1","model":"claude-tui","usage":{"input_tokens":1,"output_tokens":2},"content":[{"type":"text","text":"isolated bridge hello"}]}}'\nprintf '%s\\n' '{"type":"result","uuid":"u2","session_id":"fake-native-1","stop_reason":"end_turn","result":"done","is_error":false}'\n`);
  chmodSync(bridge, 0o700);
  const portFile = join(dir, 'port');
  const keyFile = join(dir, 'key');
  const modelsFile = join(dir, 'models');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'), CLAUDE_CONFIG_DIR: join(home, '.claude') };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ANTHROPIC_') || key.startsWith('MAGPIE_') || key === 'CLAUDE_CODE_USE_BEDROCK') delete env[key];
  }
  child = spawn(exe, ['--serve', '--state-dir', state, '--port-file', portFile,
    '--key-file', keyFile, '--models-file', modelsFile, '--bridge', bridge,
    '--helper', '/bin/false', '--models', 'claude-tui'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', chunk => { stderr += chunk.toString().slice(0, 1000); });
  for (let count = 0; count < 150 && !existsSync(portFile); count++) {
    if (child.exitCode !== null) throw new Error('isolated runtime exited early');
    await delay(50);
  }
  assert.ok(existsSync(portFile) && existsSync(keyFile), `isolated runtime not ready; ${stderr.slice(0, 350)}`);
  const port = Number(readFileSync(portFile, 'utf8'));
  assert.ok(Number.isInteger(port) && port > 1024, 'invalid ephemeral port');
  const url = `http://127.0.0.1:${port}/v1/`;
  const key = readFileSync(keyFile, 'utf8');
  assert.match(key, /^[a-f0-9]{64}$/);

  const hook = createHooks({ runtimeURL: url, models: { 'claude-tui': { name: 'Synthetic' } } });
  const headerOutput = { headers: {} };
  hook['chat.headers']({ sessionID: 'isolated-desktop-conversation-1',
    model: { providerID: 'claude-tui', id: 'claude-tui' } }, headerOutput);
  const adapter = await hook.auth.loader(async () => ({ type: 'api', key }));
  const body = JSON.stringify({ model: 'claude-tui', max_tokens: 120,
    messages: [{ role: 'user', content: 'isolated hello' }], stream: true });
  const response = await adapter.fetch(url + 'messages', { method: 'POST', headers: headerOutput.headers,
    body, signal: AbortSignal.timeout(18000) });
  const text = await response.text();
  assert.equal(response.status, 200, `status=${response.status}; body=${text.slice(0, 300)}`);
  assert.match(text, /isolated bridge hello/, 'streamed native fake CLI text missing');
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

  const unauthorized = await fetch(url + 'messages', { method: 'POST', body, headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(5000) });
  assert.equal(unauthorized.status, 401, 'missing signed envelope unexpectedly accepted');
  await unauthorized.body?.cancel();
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(done => child.once('exit', done)), delay(1200)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  rmSync(dir, { recursive: true, force: true });
}

});
