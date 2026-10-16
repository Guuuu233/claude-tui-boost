import test from 'node:test';
import assert from 'node:assert/strict';
test('extracts only official authorization URLs from terminal control sequences', async () => {
  const { authorizationURL } = await import('./scripts/ssh-login.mjs');
  assert.equal(authorizationURL('\u001b[32mhttps://claude.ai/oauth/authorize?state=fake&code_challenge=fake\u001b[0m'), 'https://claude.ai/oauth/authorize?state=fake&code_challenge=fake');
  assert.equal(authorizationURL('https://claude.ai.evil.example/oauth/authorize?state=x'), null);
  assert.equal(authorizationURL('http://localhost:123/callback?code=secret'), null);
});

import { mkdtemp, realpath, mkdir, writeFile, readFile, stat, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { beginFirstConnect, setupEnvironment, findExecutable, shellQuote } from './src/first-connect.mjs';
import { startRemote, remoteStatus, submitCode, cancelRemote } from './scripts/ssh-login.mjs';
const wait = ms => new Promise(r => setTimeout(r, ms));
const tool = new URL('./scripts/ssh-login.mjs', import.meta.url).pathname;
async function sandbox(t, timeoutMs = 12000) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'mgtui-ssh-'))); const home = join(base, 'home space'); await mkdir(home); const bin = join(home, 'bin'); await mkdir(bin);
  const env = { HOME: home, PATH: [bin, ...process.env.PATH.split(':')].join(':') };
  const tmux = await findExecutable('tmux', setupEnvironment(env, home));
  if (!tmux) { await rm(base, { recursive: true, force: true }); t.skip('tmux not installed on test host'); return null; }
  await writeFile(join(bin, 'claude'), '#!' + process.execPath + `
const fs=require('node:fs'),p=require('node:path'),rl=require('node:readline');const profile=process.env.CLAUDE_CONFIG_DIR;
if(process.argv[3]==='status'){console.log(JSON.stringify({loggedIn:fs.existsSync(p.join(profile,'ok')),authMethod:'claude.ai',configDirectory:profile}));process.exit(0)}
if(process.argv[3]!=='login')process.exit(91);
if(!process.stdin.isTTY)process.exit(92);
fs.appendFileSync(p.join(profile,'starts'),'1');
console.log('https://claude.ai/oauth/authorize?state=fake&code_challenge=not-a-real-challenge');
console.log('Paste code here if prompted:');
const r=rl.createInterface({input:process.stdin});r.once('line',line=>{if(line==='FAKE_AUTH_CODE#FAKE_STATE'){fs.writeFileSync(p.join(profile,'ok'),'fake');r.close();process.exit(0)}process.exit(93)});
`, { mode: 0o700 });
  const session = await beginFirstConnect({ home, stateRoot: join(home, 'plugin'), env, terminal: async () => false, timeoutMs, pollMs: 10 });
  const configPath = join(dirname(session.profile), 'setup.json');
  t.after(async () => {
    await cancelRemote(configPath, { env }).catch(() => {});
    try {
      const descriptor = JSON.parse(await readFile(join(dirname(session.profile), 'remote.json'), 'utf8'));
      await new Promise(res => { const c = spawn(tmux, ['-S', descriptor.socket, 'kill-server'], { stdio: 'ignore' }); c.once('error', res); c.once('exit', res); });
      await rm(dirname(descriptor.socket), { recursive: true, force: true });
    } catch {}
    // finish clears the plugin heartbeat/expiry; the sign-in directory remains
    // until its exact private tmux session has stopped.
    await session.finish().catch(() => {});
    await rm(base, { recursive: true, force: true });
  });
  return { env, home, session, configPath, tmux };
}
async function until(f, predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const result = await f(); if (predicate(result)) return result; await wait(50); }
  throw new Error('Condition not reached');
}
test('private tmux retains one login across SSH monitor hangup, then consumes a code via stdin', async t => {
  const f = await sandbox(t); if (!f) return;
  const launch = spawn(process.execPath, [tool, f.configPath, 'start'], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
  launch.stdout.on('data', x => { stdout += x; }); launch.stderr.on('data', x => { stderr += x; });
  await until(async () => stdout, x => x.includes('authorizationURL'));
  launch.kill('SIGHUP'); await new Promise(res => launch.once('exit', res));
  const state = await remoteStatus(f.configPath, { env: f.env }); assert.equal(state.phase, 'waiting_authorization', stderr);
  assert.match(state.authorizationURL, /^https:\/\/claude.ai\/oauth\/authorize/);
  await startRemote(f.configPath, { env: f.env }); // idempotent reconnect
  assert.equal(await readFile(join(f.session.profile, 'starts'), 'utf8'), '1');
  const code = spawn(process.execPath, [tool, f.configPath, 'code'], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] }); let codeOutput = ''; code.stdout.on('data', x => { codeOutput += x; });code.stderr.on('data', x => { codeOutput += x; });
  code.stdin.end('FAKE_AUTH_CODE#FAKE_STATE\n');
  assert.equal(await new Promise(res => code.once('exit', res)), 0, codeOutput);
  assert.ok(!codeOutput.includes('FAKE_AUTH_CODE'));
  const result = await f.session.finish(); assert.equal(result.profile, f.session.profile);
  assert.equal((await remoteStatus(f.configPath, { env: f.env })).phase, 'authenticated');
  await assert.rejects(submitCode(f.configPath, 'FAKE_AUTH_CODE#FAKE_STATE', { env: f.env }), /等待授权|重放|Remote login command/);
});
test('wrong origins, callbacks and terminal escapes are not relayed as authorization URLs', async () => {
  const { authorizationURL } = await import('./scripts/ssh-login.mjs');
  for (const text of ['https://claude.ai.evil.com/oauth/authorize?state=x&code_challenge=y','https://user@claude.ai/oauth/authorize?state=x&code_challenge=y','https://claude.ai:444/oauth/authorize?state=x&code_challenge=y','https://claude.ai/oauth/callback?code=sensitive','http://127.0.0.1:123/callback?code=sensitive']) assert.equal(authorizationURL(text), null);
  assert.equal(authorizationURL('not an authorization link'), null);
});
test('code interface rejects multiline input, callback URLs and replay', async t => {
  const f = await sandbox(t); if (!f) return;
  await startRemote(f.configPath, { env: f.env });
  await until(() => remoteStatus(f.configPath, { env: f.env }), s => s.phase === 'waiting_authorization');
  for (const value of ['a\nb', 'https://localhost/callback?code=x', '\u001b[D', ' a ']) await assert.rejects(submitCode(f.configPath, value, { env: f.env }), /单行授权码/);
  await submitCode(f.configPath, 'FAKE_AUTH_CODE#FAKE_STATE', { env: f.env });
  await assert.rejects(submitCode(f.configPath, 'FAKE_AUTH_CODE#FAKE_STATE', { env: f.env }), /重放|等待授权/);
});
test('cancel and timeout never claim an authenticated login', async t => {
  const f = await sandbox(t, 4000); if (!f) return;
  await startRemote(f.configPath, { env: f.env });
  await until(() => remoteStatus(f.configPath, { env: f.env }), s => s.phase === 'waiting_authorization');
  await cancelRemote(f.configPath, { env: f.env });
  await assert.rejects(f.session.finish(), /取消/);
  assert.notEqual((await remoteStatus(f.configPath, { env: f.env })).phase, 'authenticated');
});

test('supports current claude.com and legacy claude.ai authorization routes', async () => {
  const { authorizationURL } = await import('./scripts/ssh-login.mjs');
  const current = 'https://claude.com/cai/oauth/authorize?code=true&state=fake&code_challenge=fake';
  assert.equal(authorizationURL(current), current);
  assert.equal(authorizationURL('https://claude.com/other?state=fake&code_challenge=fake'), null);
});
test('canceling one login never terminates another account private tmux', async t => {
  const a = await sandbox(t), b = await sandbox(t); if (!a || !b) return;
  await Promise.all([startRemote(a.configPath, { env: a.env }), startRemote(b.configPath, { env: b.env })]);
  await until(() => remoteStatus(a.configPath, { env: a.env }), s => s.phase === 'waiting_authorization');
  await until(() => remoteStatus(b.configPath, { env: b.env }), s => s.phase === 'waiting_authorization');
  await cancelRemote(a.configPath, { env: a.env }); await assert.rejects(a.session.finish(), /取消/);
  assert.equal((await remoteStatus(b.configPath, { env: b.env })).phase, 'waiting_authorization');
  await submitCode(b.configPath, 'FAKE_AUTH_CODE#FAKE_STATE', { env: b.env }); await b.session.finish();
});
test('expired SSH setup refuses old codes and a new start cannot spawn another login', async t => {
  const f = await sandbox(t, 1400); if (!f) return;
  await startRemote(f.configPath, { env: f.env });
  await until(() => remoteStatus(f.configPath, { env: f.env }), s => s.phase === 'waiting_authorization');
  await assert.rejects(f.session.finish(), /超时/);
  assert.notEqual((await startRemote(f.configPath, { env: f.env })).phase, 'waiting_authorization');
  await assert.rejects(submitCode(f.configPath, 'FAKE_AUTH_CODE#FAKE_STATE', { env: f.env }), /等待授权|重放/);
  assert.equal(await readFile(join(f.session.profile, 'starts'), 'utf8'), '1');
});
test('foreign tmux identity is refused without operating the foreign session', async t => {
  const a = await sandbox(t), b = await sandbox(t); if (!a || !b) return;
  await Promise.all([startRemote(a.configPath, { env: a.env }), startRemote(b.configPath, { env: b.env })]);
  await until(() => remoteStatus(a.configPath, { env: a.env }), s => s.phase === 'waiting_authorization');
  const path = join(dirname(a.configPath), 'remote.json'); const original = await readFile(path, 'utf8');
  const foreign = JSON.parse(await readFile(join(dirname(b.configPath), 'remote.json'), 'utf8')); foreign.owner = JSON.parse(original).owner;
  try {
    await writeFile(path, JSON.stringify(foreign), { mode: 0o600 });
    await assert.rejects(remoteStatus(a.configPath, { env: a.env }), /owner mismatch/);
    assert.equal((await remoteStatus(b.configPath, { env: b.env })).phase, 'waiting_authorization');
  } finally { await writeFile(path, original, { mode: 0o600 }); }
});

test('unexpected remote process exit publishes a failed result for the Magpie callback', async t => {
  const f = await sandbox(t, 10000); if (!f) return;
  await startRemote(f.configPath, { env: f.env });
  await until(() => remoteStatus(f.configPath, { env: f.env }), s => s.phase === 'waiting_authorization');
  const d = JSON.parse(await readFile(join(dirname(f.configPath), 'remote.json'), 'utf8'));
  await new Promise(res => { const c = spawn(f.tmux, ['-S', d.socket, 'kill-server'], { stdio: 'ignore' }); c.once('exit', res); });
  await assert.rejects(f.session.finish(), /退出|中断|取消|失败|无法确认/);
  assert.notEqual((await remoteStatus(f.configPath, { env: f.env })).phase, 'authenticated');
});
