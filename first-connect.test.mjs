import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, stat, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { beginFirstConnect, launchTerminal, privateDirectory, setupEnvironment, shellQuote } from './src/first-connect.mjs';
import { installPlan, runSetup, validSubscriptionStatus } from './scripts/first-connect-runner.mjs';
import { createManagedHooks } from './src/managed-runtime.mjs';

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'mgtui-connect-')));
  const home = join(base, 'home space'); await mkdir(home);
  const bin = join(home, 'bin'); await mkdir(bin);
  const env = { HOME: home, PATH: bin, ANTHROPIC_API_KEY: 'secret-test-sentinel', CLAUDE_CODE_OAUTH_TOKEN: 'secret-test-sentinel', NODE_OPTIONS: 'secret-test-sentinel' };
  const children = [];
  t.after(async () => {
    for (const c of children) {
      if (c.exitCode === null && c.signalCode === null) {
        c.kill('SIGTERM'); await new Promise(r => { c.once('exit', r); setTimeout(() => { c.kill('SIGKILL'); r(); }, 1500).unref(); });
      }
    }
    await rm(base, { recursive: true, force: true });
  });
  const exe = async (name, source) => { const path = join(bin, name); await writeFile(path, '#!' + process.execPath + '\n' + source, { mode: 0o700 }); return path; };
  await exe('claude', `const fs=require('node:fs');const p=require('node:path');
if(process.env.ANTHROPIC_API_KEY||process.env.CLAUDE_CODE_OAUTH_TOKEN||process.env.NODE_OPTIONS)process.exit(99);
const profile=process.env.CLAUDE_CONFIG_DIR;
if(process.argv[2]==='auth'&&process.argv[3]==='login'){fs.writeFileSync(p.join(profile,'logged-in'),'fake');process.exit(0)}
if(process.argv[2]==='auth'&&process.argv[3]==='status'){console.log(JSON.stringify({loggedIn:fs.existsSync(p.join(profile,'logged-in')),authMethod:'claude.ai',configDirectory:profile}));process.exit(0)}
process.exit(91);`);
  await exe('tmux', 'process.exit(0)');
  return { base, home, bin, env, exe, children };
}

test('env preserves configured proxy and removes inherited auth/exec overrides', () => {
  const clean = setupEnvironment({ PATH: '/bin', HTTPS_PROXY: 'http://proxy:123', ANTHROPIC_BASE_URL: 'http://localhost', CLAUDE_CODE_OAUTH_TOKEN: 'secret', NODE_OPTIONS: 'bad' }, '/private/home');
  assert.equal(clean.HTTPS_PROXY, 'http://proxy:123');
  for (const key of ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'NODE_OPTIONS']) assert.equal(clean[key], undefined);
});

test('subscription verification requires loggedIn, subscription method and exact dedicated directory', () => {
  const good = { loggedIn: true, authMethod: 'claude.ai', configDirectory: '/home/test/profile' };
  assert.equal(validSubscriptionStatus(good, good.configDirectory), true);
  for (const bad of [{ ...good, loggedIn: false }, { ...good, authMethod: 'api_key' }, { ...good, configDirectory: '/home/test/.claude' }, { ...good, configDirectory: undefined }]) assert.equal(validSubscriptionStatus(bad, good.configDirectory), false);
});

test('install plans use fixed package names and preserve interactive sudo', () => {
  assert.deepEqual(installPlan('darwin', { brew: '/opt/homebrew/bin/brew' }), ['/opt/homebrew/bin/brew', ['install', 'tmux']]);
  assert.deepEqual(installPlan('linux', { 'apt-get': '/usr/bin/apt-get', sudo: '/usr/bin/sudo' }, 1000), ['/usr/bin/sudo', ['/usr/bin/apt-get', 'install', '-y', 'tmux']]);
  assert.deepEqual(installPlan('linux', { dnf: '/bin/dnf' }, 0), ['/bin/dnf', ['install', '-y', 'tmux']]);
  assert.throws(() => installPlan('darwin', {}), /Homebrew/);
});

test('no side effects until explicit authorize; default method needs no path/model prompts', async t => {
  const f = await fixture(t);
  const hooks = createManagedHooks({ env: f.env, input: { directory: join(f.home, 'owned') } });
  assert.match(hooks.auth.methods[0].label, /自动安装/);
  assert.equal(hooks.auth.methods[0].prompts, undefined);
  assert.match(hooks.auth.methods[1].label, /已登录/);
  await assert.rejects(stat(join(f.home, 'owned')), /ENOENT/);
});

test('real setup runner performs fake official login with scrubbed env and returns no credentials', async t => {
  const f = await fixture(t);
  let command;
  const session = await beginFirstConnect({ home: f.home, stateRoot: join(f.home, 'plugin'), env: { ...f.env, HTTPS_PROXY: 'http://user:private-proxy-password@proxy:8080' },
    terminal: async cmd => { command = cmd; const c = spawn('/bin/sh', ['-c', cmd], { env: f.env, stdio: 'ignore' }); f.children.push(c); return true; }, timeoutMs: 5000, pollMs: 10 });
  assert.equal(session.opened, true);
  assert.ok(!command.includes('secret-test-sentinel'));
  assert.ok(!command.includes('private-proxy-password'));
  const result = await session.finish();
  assert.deepEqual(result.models, ['sonnet', 'opus', 'haiku']);
  assert.equal(await readFile(join(result.profile, 'logged-in'), 'utf8'), 'fake');
  assert.equal((await stat(result.profile)).mode & 0o777, 0o700);
  assert.ok(!(await readFile(join(result.profile, '..', 'result.json'), 'utf8')).includes('secret-test-sentinel'));
  await assert.rejects(session.finish(), /already completed/);
});

test('runner installs missing tmux before logging in and verifies it exists afterward', async t => {
  const f = await fixture(t); let installed = false; const calls = [];
  const profile = join(f.home, 'profile');
  const result = await runSetup({ v: 1, home: f.home, profile, deadline: Date.now() + 2000 }, {
    env: f.env, os: 'darwin', say: () => {},
    find: async name => name === 'tmux' ? installed ? '/bin/tmux' : null : name === 'brew' ? '/bin/brew' : name === 'claude' ? '/bin/claude' : null,
    run: async (file, args, opts) => { calls.push([file, args]); assert.equal(opts.env.ANTHROPIC_API_KEY, undefined); if (file === '/bin/brew') installed = true; return JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', configDirectory: profile }); },
  });
  assert.equal(result.ok, true); assert.deepEqual(calls[0], ['/bin/brew', ['install', 'tmux']]);
});

test('failed installation never starts login', async t => {
  const f = await fixture(t); const calls = [];
  await assert.rejects(runSetup({ v: 1, home: f.home, profile: join(f.home, 'profile'), deadline: Date.now() + 1000 }, {
    env: f.env, os: 'darwin', say: () => {}, find: async name => name === 'tmux' ? null : '/bin/' + name,
    run: async (file, args) => { calls.push(args); throw new Error('installation failed'); },
  }), /installation failed/);
  assert.deepEqual(calls, [['install', 'tmux']]);
});

test('successful login exit alone cannot mark a console/API profile connected', async t => {
  const f = await fixture(t); const profile = join(f.home, 'profile');
  await assert.rejects(runSetup({ v: 1, home: f.home, profile, deadline: Date.now() + 1000 }, {
    env: f.env, say: () => {}, find: async name => '/bin/' + name,
    run: async () => JSON.stringify({ loggedIn: true, authMethod: 'api_key', configDirectory: profile }),
  }), /无法确认/);
});

test('private setup refuses symlinked ancestors and paths outside HOME', async t => {
  const f = await fixture(t); const link = join(f.home, 'alias'); await symlink(f.bin, link);
  await assert.rejects(privateDirectory(join(link, 'child'), f.home), /real directories/);
  await assert.rejects(privateDirectory(join(f.base, 'outside'), f.home), /inside the user home/);
});

test('timeout of abandoned setup produces no success and writes cancellation marker', async t => {
  const f = await fixture(t);
  const session = await beginFirstConnect({ home: f.home, stateRoot: join(f.home, 'plugin'), env: f.env, terminal: async () => false, timeoutMs: 50, pollMs: 5 });
  assert.equal(session.opened, false); assert.match(session.command, /env.*-i/);
  await assert.rejects(session.finish(), /超时/);
  await stat(join(session.profile, '..', 'cancel'));
});

test('shell quoting preserves adversarial path text without execution', async t => {
  const f = await fixture(t); const path = `a ' $(touch ${f.home}/injected) \`whoami\` b`;
  const output = await new Promise((res, rej) => {
    const c = spawn('/bin/sh', ['-c', `printf '%s' ${shellQuote(path)}`]); let s = ''; c.stdout.on('data', d => { s += d; }); c.once('error', rej); c.once('close', () => res(s));
  });
  assert.equal(output, path); await assert.rejects(stat(join(f.home, 'injected')), /ENOENT/);
});

test('terminal adapters pass argv correctly on macOS/Linux and avoid headless spawns', async () => {
  const calls = [];
  const fakeSpawn = (file, args) => { calls.push({ file, args }); const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => { child.emit('spawn'); child.emit('exit', 0); }); return child; };
  assert.equal(await launchTerminal("echo 'path with space'", {}, { os: 'darwin', spawnProcess: fakeSpawn }), true);
  assert.equal(calls[0].file, '/usr/bin/osascript'); assert.ok(calls[0].args.some(a => a.startsWith('do script ')));
  assert.equal(await launchTerminal('echo hi', { DISPLAY: ':0' }, { os: 'linux', find: async n => n === 'xterm' ? '/bin/xterm' : null, spawnProcess: fakeSpawn }), true);
  assert.deepEqual(calls[1], { file: '/bin/xterm', args: ['-e', '/bin/sh', '-c', 'echo hi'] });
  assert.equal(await launchTerminal('echo hi', {}, { os: 'linux', spawnProcess: () => { throw new Error('unexpected'); } }), false);
});

test('automatic auth does not save an account before verified setup', async t => {
  const f = await fixture(t);
  const hooks = createManagedHooks({ env: f.env, onboarding: async () => ({ opened: true, finish: async () => { throw new Error('user canceled'); } }), spawnRuntime: () => { throw new Error('must not start'); } });
  const flow = await hooks.auth.methods[0].authorize(); const result = await flow.callback();
  assert.deepEqual(result, { type: 'failed', error: 'user canceled' });
});

test('verified automatic setup starts the actual bundled runtime before returning a saved key', async t => {
  const f = await fixture(t); const profile = join(f.home, 'profile'); await mkdir(profile);
  const hooks = createManagedHooks({ env: { ...f.env, ANTHROPIC_BASE_URL: 'http://localhost:9999' }, input: { directory: join(f.home, 'plugin') },
    onboarding: async () => ({ opened: true, finish: async () => ({ profile, models: ['sonnet', 'opus', 'haiku'] }) }),
    deps: async () => ({ bun: '/bin/fake', claude: join(f.bin, 'claude'), tmux: join(f.bin, 'tmux') }),
    spawnRuntime: (args, opts) => { const child = spawn(process.execPath, args, { ...opts, stdio: ['pipe', 'ignore', 'pipe'] }); f.children.push(child); return child; },
  });
  const flow = await hooks.auth.methods[0].authorize(); const result = await flow.callback();
  assert.equal(result.type, 'success', result.error); assert.ok(result.key.startsWith('mgtui1.'));
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: result.key }));
  assert.match(loader.baseURL, /^http:\/\/127\.0\.0\.1:/);
  assert.equal(f.children.length, 1); // cached startup, no second runtime
  const models = await hooks.provider.models({}, { auth: { type: 'api', key: result.key } });
  assert.deepEqual(Object.keys(models), ['sonnet', 'opus', 'haiku']);
});

test('runtime startup failure returns failed auth, without a saved key', async t => {
  const f = await fixture(t); const profile = join(f.home, 'profile'); await mkdir(profile);
  const hooks = createManagedHooks({ env: f.env,
    onboarding: async () => ({ opened: true, finish: async () => ({ profile, models: ['sonnet'] }) }),
    deps: async () => ({ bun: '/bin/fake', claude: '/bin/fake', tmux: '/bin/fake' }), runtimeEntry: () => null,
  });
  const result = await (await hooks.auth.methods[0].authorize()).callback();
  assert.equal(result.type, 'failed'); assert.equal(result.key, undefined); assert.match(result.error, /no bundled/);
});

test('advanced existing-profile connection remains compatible', async t => {
  const f = await fixture(t); const profile = join(f.home, 'old-profile'); await mkdir(profile);
  const hooks = createManagedHooks({ env: f.env, deps: async () => ({ bun: 'fake', claude: 'fake', tmux: 'fake' }) });
  const result = await (await hooks.auth.methods[1].authorize({ profileDir: profile, models: 'existing-custom-model' })).callback();
  assert.equal(result.type, 'success');
  assert.deepEqual(Object.keys(await hooks.provider.models({}, { auth: { type: 'api', key: result.key } })), ['existing-custom-model']);
  assert.deepEqual(await readFile(join(f.bin, 'claude'), 'utf8').then(() => true), true);
});

test('terminal cancellation stops the owned login process and cannot report success', async t => {
  const f = await fixture(t);
  await f.exe('claude', `const fs=require('node:fs'),p=require('node:path');
if(process.argv[3]==='status'){console.log(JSON.stringify({loggedIn:false}));process.exit(0)}
fs.writeFileSync(p.join(process.env.CLAUDE_CONFIG_DIR,'login-started'),'fake');setInterval(()=>{},1000);`);
  const session = await beginFirstConnect({ home: f.home, stateRoot: join(f.home, 'plugin'), env: f.env,
    terminal: async command => { const child = spawn('/bin/sh', ['-c', command], { env: f.env, stdio: 'ignore' }); f.children.push(child); return true; }, timeoutMs: 6000, pollMs: 10 });
  const deadline = Date.now() + 3000;
  while (true) {
    try { await stat(join(session.profile, 'login-started')); break; }
    catch (e) { if (Date.now() > deadline) throw e; await new Promise(r => setTimeout(r, 20)); }
  }
  await writeFile(join(session.profile, '..', 'cancel'), '', { mode: 0o600 });
  await assert.rejects(session.finish(), /取消/);
});

test('inspected Magpie host completes automatic auth and persists only the opaque account key', { skip: !process.env.MAGPIE_TUI_TEST_HOST }, async t => {
  const f = await fixture(t);
  const { createInterface } = await import('node:readline');
  const pluginPath = join(f.home, 'host-fixture.mjs');
  const managedURL = new URL('./src/managed-runtime.mjs', import.meta.url).href;
  const setupURL = new URL('./src/first-connect.mjs', import.meta.url).href;
  await writeFile(pluginPath, `import {createManagedHooks} from ${JSON.stringify(managedURL)};
import {beginFirstConnect} from ${JSON.stringify(setupURL)};
import {spawn} from 'node:child_process';
export async function Wizard(input){return createManagedHooks({input,onboarding:options=>beginFirstConnect({...options,timeoutMs:10000,terminal:async command=>{const c=spawn('/bin/sh',['-c',command],{env:process.env,stdio:'ignore'});c.unref();return true}})})}
`);
  const authPath = join(f.home, 'plugin-auth.json');
  const host = spawn(process.execPath, [process.env.MAGPIE_TUI_TEST_HOST], { env: { ...setupEnvironment(f.env, f.home), XDG_CONFIG_HOME: join(f.home, 'config'), XDG_CACHE_HOME: join(f.home, 'cache') }, cwd: f.home, stdio: ['pipe', 'pipe', 'pipe'] });
  f.children.push(host);
  let errorLog = ''; host.stderr.on('data', d => { errorLog += d; });
  const pending = new Map(); let sequence = 0;
  const lines = createInterface({ input: host.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line); const request = pending.get(message.id);
    if (!request || !('result' in message || message.error)) return;
    clearTimeout(request.timer); pending.delete(message.id);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Host RPC timeout: ' + method + ': ' + errorLog)); }, 15000);
    pending.set(id, { resolve, reject, timer }); host.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    const initialized = await rpc('init', { directory: join(f.home, 'state'), authPath, plugins: [{ spec: 'wizard-fixture', target: pluginPath }] });
    assert.equal(initialized.plugins[0].error, undefined);
    const next = await rpc('prompt', { provider: 'claude-tui', method: 0, inputs: {} }); assert.equal(next.prompt, null);
    const flow = await rpc('authorize', { provider: 'claude-tui', method: 0, inputs: {} }); assert.equal(flow.method, 'auto');
    const result = await rpc('callback', { session: flow.session }); assert.equal(result.ok, true);
    const auth = JSON.parse(await readFile(authPath, 'utf8'));
    const key = Object.values(auth).find(a => a.type === 'api')?.key;
    assert.ok(key?.startsWith('mgtui1.'));
    assert.ok(!JSON.stringify(auth).includes('accessToken'));
    const listing = await rpc('providers', {}); assert.ok(JSON.stringify(listing).includes('sonnet'));
    await assert.rejects(rpc('callback', { session: flow.session }), /no such sign-in/);
  } finally {
    host.stdin.end();
    await new Promise(r => { if (host.exitCode !== null) return r(); host.once('exit', r); setTimeout(() => { host.kill('SIGTERM'); r(); }, 2000).unref(); });
    lines.close(); for (const p of pending.values()) clearTimeout(p.timer);
    await new Promise(r => setTimeout(r, 250));
  }
});

test('macOS without brew uses official installer before tmux and login', async t => {
  const f = await fixture(t); const profile = join(f.home, 'profile'); let brew = false, tmux = false; const calls = [];
  const result = await runSetup({ v: 1, home: f.home, profile, deadline: Date.now() + 1000 }, {
    env: f.env, os: 'darwin', say: () => {},
    find: async name => name === 'tmux' ? tmux ? '/bin/tmux' : null : name === 'brew' ? brew ? '/bin/brew' : null : ['claude', 'curl'].includes(name) ? '/bin/' + name : null,
    run: async (file, args) => { calls.push([file, args]); if (file === '/bin/bash') brew = true; if (file === '/bin/brew') tmux = true; return JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', configDirectory: profile }); },
  });
  assert.equal(result.ok, true); assert.equal(calls[0][0], '/bin/curl'); assert.equal(calls[0][1].at(-1), 'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh');
  assert.deepEqual(calls[1], ['/bin/bash', [join(f.home, 'homebrew-install.sh')]]);
  assert.deepEqual(calls[2], ['/bin/brew', ['install', 'tmux']]);
});
