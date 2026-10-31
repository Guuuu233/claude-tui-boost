import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('actual supervisor passes only explicit recovery booleans to its owned runtime', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'mgtui-env-')));
  const state = join(home, 'state');
  const runtime = join(home, 'fake-runtime.mjs');
  await writeFile(runtime, '#!' + process.execPath + `
import { writeFileSync } from 'node:fs';
const opt = name => process.argv[process.argv.indexOf(name) + 1];
const observed = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('MAGPIE_CLAUDE_') || ['ANTHROPIC_API_KEY', 'NODE_OPTIONS'].includes(k)));
writeFileSync(opt('--state-dir') + '/observed.json', JSON.stringify(observed));
writeFileSync(opt('--key-file'), 'a'.repeat(64));
writeFileSync(opt('--models-file'), '{}');
writeFileSync(opt('--port-file'), '12345');
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./scripts/managed-runtime-supervisor.mjs', import.meta.url)), '--runtime', runtime, '--state-dir', state, '--ready-file', join(state, 'ready.json')], {
    env: { PATH: process.env.PATH, HOME: home, MAGPIE_CLAUDE_NATIVE_TMUX_GUARD: '1', MAGPIE_CLAUDE_DURABLE_TOOL_JOURNAL: '0',
      MAGPIE_CLAUDE_AUTO_READONLY_HISTORY_DRIFT: '1', MAGPIE_CLAUDE_AUTO_RECOVER_ORPHANS: 'yes', ANTHROPIC_API_KEY: 'fake-do-not-forward',
      MANAGED_RUNTIME_EXTRA_ENV: 'ANTHROPIC_API_KEY,MAGPIE_CLAUDE_LEGACY_OPERATOR_APPROVED', MAGPIE_CLAUDE_LEGACY_OPERATOR_APPROVED: '1' },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let error = ''; child.stderr.on('data', d => { error += d; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  try {
    const deadline = Date.now() + 5000;
    while (true) {
      try { await readFile(join(state, 'ready.json')); break; }
      catch (e) { if (Date.now() > deadline || child.exitCode !== null) throw new Error('Supervisor did not become ready: ' + error); await new Promise(r => setTimeout(r, 20)); }
    }
    const observed = JSON.parse(await readFile(join(state, 'observed.json'), 'utf8'));
    assert.deepEqual(observed, { MAGPIE_CLAUDE_NATIVE_TMUX_GUARD: '1', MAGPIE_CLAUDE_DURABLE_TOOL_JOURNAL: '0', MAGPIE_CLAUDE_AUTO_READONLY_HISTORY_DRIFT: '1' });
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGTERM'), 2000);
    await exited; clearTimeout(timer); await rm(home, { recursive: true, force: true });
  }
});

test('supervisor reclaims a stale .managed-live claim from a dead PID or previous boot, but refuses a live PID', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'mgtui-claim-')));
  const state = join(home, 'state');
  const runtime = join(home, 'fake-runtime.mjs');
  const supervisor = fileURLToPath(new URL('./scripts/managed-runtime-supervisor.mjs', import.meta.url));
  const managedKey = 'b'.repeat(64);
  await writeFile(runtime, '#!' + process.execPath + `
import { writeFileSync } from 'node:fs';
const opt = name => process.argv[process.argv.indexOf(name) + 1];
writeFileSync(opt('--key-file'), '${managedKey}');
writeFileSync(opt('--models-file'), '{}');
writeFileSync(opt('--port-file'), '12346');
setInterval(() => {}, 1000);
`, { mode: 0o700 });

  // First run creates state-dir and .managed-owner, then we leave a stale .managed-live with a dead PID
  const c1 = spawn(process.execPath, [supervisor, '--runtime', runtime, '--state-dir', state, '--ready-file', join(home, 'ready1.json'), '--managed-key', managedKey], {
    env: { PATH: process.env.PATH, HOME: home }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  try {
    const deadline = Date.now() + 5000;
    while (true) {
      try { await readFile(join(home, 'ready1.json')); break; }
      catch { if (Date.now() > deadline) throw new Error('c1 timeout'); await new Promise(r => setTimeout(r, 20)); }
    }
  } finally {
    c1.stdin.end();
    await new Promise(r => c1.once('exit', r));
  }

  // Write a stale .managed-live pointing to a non-existent PID (999999) from an old timestamp
  await writeFile(join(state, '.managed-live'), '999999 1000000000000 old-boot-uuid\n', { mode: 0o600 });

  const c2 = spawn(process.execPath, [supervisor, '--runtime', runtime, '--state-dir', state, '--ready-file', join(home, 'ready2.json'), '--managed-key', managedKey], {
    env: { PATH: process.env.PATH, HOME: home }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  let c2Err = ''; c2.stderr.on('data', d => { c2Err += d; });
  try {
    const deadline = Date.now() + 5000;
    while (true) {
      try { await readFile(join(home, 'ready2.json')); break; }
      catch { if (Date.now() > deadline || c2.exitCode !== null) throw new Error('c2 failed to reclaim stale lock: ' + c2Err); await new Promise(r => setTimeout(r, 20)); }
    }
    // While c2 is still alive, a concurrent c3 must be refused
    const c3 = spawn(process.execPath, [supervisor, '--runtime', runtime, '--state-dir', state, '--ready-file', join(home, 'ready3.json'), '--managed-key', managedKey], {
      env: { PATH: process.env.PATH, HOME: home }, stdio: ['pipe', 'ignore', 'pipe'],
    });
    let c3Err = ''; c3.stderr.on('data', d => { c3Err += d; });
    const c3Code = await new Promise(r => c3.once('exit', r));
    assert.equal(c3Code, 2);
    assert.match(c3Err, /already has a live supervisor claim/);
  } finally {
    c2.stdin.end();
    await new Promise(r => c2.once('exit', r));
    await rm(home, { recursive: true, force: true });
  }
});
