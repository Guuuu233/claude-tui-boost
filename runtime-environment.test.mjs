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
      MAGPIE_CLAUDE_AUTO_RECOVER_ORPHANS: 'yes', ANTHROPIC_API_KEY: 'fake-do-not-forward',
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
    assert.deepEqual(observed, { MAGPIE_CLAUDE_NATIVE_TMUX_GUARD: '1', MAGPIE_CLAUDE_DURABLE_TOOL_JOURNAL: '0' });
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGTERM'), 2000);
    await exited; clearTimeout(timer); await rm(home, { recursive: true, force: true });
  }
});
