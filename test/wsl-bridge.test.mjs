import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { isPrivateDirMode, isPrivateFileMode, probeWslDeps, toWslPath, wslEnvAssignments, wslShellQuote } from '../src/wsl.mjs';
import { beginFirstConnect, launchTerminal } from '../src/first-connect.mjs';
import { createManagedHooks } from '../src/managed-runtime.mjs';
import { readClaudeUsage } from '../src/claude-usage.mjs';

test('toWslPath converts Windows drive paths and normalizes POSIX paths', () => {
  assert.equal(toWslPath('C:\\Users\\alice\\.config\\magpie'), '/mnt/c/Users/alice/.config/magpie');
  assert.equal(toWslPath('D:/work/space dir/file.json'), '/mnt/d/work/space dir/file.json');
  assert.equal(toWslPath('C:\\'), '/mnt/c');
  assert.equal(toWslPath('/tmp/already/posix'), '/tmp/already/posix');
  assert.throws(() => toWslPath(''), /non-empty/);
  assert.throws(() => toWslPath('relative\\path'), /Unsupported/);
});

test('isPrivateFileMode and isPrivateDirMode accept win32 modes and enforce POSIX modes on unix', () => {
  assert.equal(isPrivateFileMode(0o666, 'win32'), true);
  assert.equal(isPrivateFileMode(0o644, 'linux'), false);
  assert.equal(isPrivateFileMode(0o600, 'linux'), true);
  assert.equal(isPrivateDirMode(0o777, 'win32'), true);
  assert.equal(isPrivateDirMode(0o755, 'darwin'), false);
  assert.equal(isPrivateDirMode(0o700, 'darwin'), true);
});

test('wslEnvAssignments quotes safe variables and omits credentials', () => {
  const assigns = wslEnvAssignments({
    HOME: '/mnt/c/Users/alice',
    HTTPS_PROXY: "http://proxy:8080/a'b",
    ANTHROPIC_API_KEY: 'secret-must-not-pass',
  });
  assert.deepEqual(assigns, [
    "HOME='/mnt/c/Users/alice'",
    "HTTPS_PROXY='http://proxy:8080/a'\\''b'",
  ]);
});

test('probeWslDeps parses WSL2 tool paths and architecture', async () => {
  const fakeSpawn = (file, args) => {
    assert.equal(file, 'wsl.exe');
    assert.equal(args[0], '--');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('arch=x86_64\nbun=/home/u/.bun/bin/bun\nnode=/usr/bin/node\ntmux=/usr/bin/tmux\nclaude=/home/u/.local/bin/claude\n'));
      child.emit('close', 0);
    });
    return child;
  };
  const info = await probeWslDeps({ spawnImpl: fakeSpawn });
  assert.deepEqual(info, {
    wsl: 'wsl.exe',
    arch: 'amd64',
    bun: '/home/u/.bun/bin/bun',
    node: '/usr/bin/node',
    tmux: '/usr/bin/tmux',
    claude: '/home/u/.local/bin/claude',
  });
});

test('launchTerminal on win32 uses wt.exe when present and falls back to cmd start wsl.exe', async () => {
  const calls = [];
  const fakeSpawn = (file, args) => {
    calls.push({ file, args });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => { child.emit('spawn'); child.emit('exit', 0); });
    return child;
  };
  assert.equal(await launchTerminal('echo hello', {}, {
    os: 'win32',
    find: async name => name === 'wt.exe' ? 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe' : null,
    spawnProcess: fakeSpawn,
  }), true);
  assert.equal(calls[0].file, 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe');
  assert.deepEqual(calls[0].args, ['new-tab', 'wsl.exe', '--', '/bin/sh', '-lc', 'echo hello']);

  assert.equal(await launchTerminal('echo fallback', {}, {
    os: 'win32',
    find: async () => null,
    spawnProcess: fakeSpawn,
  }), true);
  assert.equal(calls[1].file, 'cmd.exe');
  assert.deepEqual(calls[1].args, ['/c', 'start', '""', 'wsl.exe', '--', '/bin/sh', '-lc', 'echo fallback']);
});

test('beginFirstConnect on win32 bridges setup into WSL2 and accepts non-0600 result file', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'mgtui-win32-connect-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  await mkdir(home);
  let launchedCmd = '';
  const session = await beginFirstConnect({
    home,
    stateRoot: join(home, 'plugin'),
    env: { HOME: home, PATH: '' },
    os: 'win32',
    wslDeps: async () => ({ wsl: 'wsl.exe', arch: 'amd64', bun: '/usr/bin/bun', tmux: '/usr/bin/tmux', claude: '/usr/bin/claude' }),
    terminal: async cmd => {
      launchedCmd = cmd;
      await mkdir(sessionProfile);
      await writeFile(join(sessionProfile, '..', 'result.json'), JSON.stringify({ v: 1, ok: true, profile: sessionProfile }), { mode: 0o644 });
      return false;
    },
    timeoutMs: 3000,
    pollMs: 10,
  });
  var sessionProfile = session.profile;
  assert.equal(session.opened, false);
  assert.match(session.command, /^wsl\.exe -- \/bin\/sh -lc /);
  await mkdir(session.profile, { recursive: true });
  await writeFile(join(session.profile, '..', 'result.json'), JSON.stringify({ v: 1, ok: true, profile: toWslPath(session.profile) }), { mode: 0o644 });
  const finished = await session.finish();
  assert.equal(finished.profile, session.profile);
  assert.deepEqual(finished.models, ['sonnet', 'opus', 'haiku']);
});

test('createManagedHooks on win32 starts supervisor and validates handshake with non-0600 key mode', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'mgtui-win32-managed-')));
  const children = [];
  t.after(async () => {
    for (const c of children) {
      if (c.exitCode === null) c.kill('SIGTERM');
    }
    await rm(base, { recursive: true, force: true });
  });
  const home = join(base, 'home');
  const profile = join(home, 'profile');
  const bin = join(home, 'bin');
  await mkdir(profile, { recursive: true });
  await mkdir(bin, { recursive: true });
  const claudePath = join(bin, 'claude');
  await writeFile(claudePath, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.296"; exit 0; fi\nexit 0\n', { mode: 0o700 });

  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const hostRuntimeBin = join(process.cwd(), 'bin', `magpie-tui-runtime.${process.platform}-${arch}`);

  const hooks = createManagedHooks({
    os: 'win32',
    env: { HOME: home, PATH: `${bin}:${process.env.PATH}` },
    input: { directory: join(home, 'plugin') },
    onboarding: async () => ({ opened: true, finish: async () => ({ profile, models: ['sonnet'] }) }),
    deps: async () => ({ wsl: 'wsl.exe', arch, bun: process.execPath, claude: claudePath, tmux: '/usr/bin/tmux' }),
    runtimeEntry: () => hostRuntimeBin,
    spawnRuntime: (args, opts) => {
      const child = spawn(process.execPath, args, { env: opts.env, stdio: ['pipe', 'ignore', 'pipe'] });
      children.push(child);
      return child;
    },
  });
  const flow = await hooks.auth.methods[0].authorize();
  const res = await flow.callback();
  assert.equal(res.type, 'success', res.error);
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: res.key }));
  assert.match(loader.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1\/$/);
});

test('readClaudeUsage on win32 invokes wsl.exe with translated WSL profile path', async () => {
  let seenExe, seenArgs;
  const fakeSpawn = (exe, args) => {
    seenExe = exe;
    seenArgs = args;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'result',
        is_error: false,
        result: 'Current session: 20% used · resets Oct 23 at 9pm (UTC)\nCurrent week (all models): 45% used · resets Oct 27 at 9pm (UTC)\n',
      })));
      child.emit('close', 0, null);
    });
    return child;
  };
  const usage = await readClaudeUsage({
    profileDir: '/tmp/win-wsl-usage-test',
    os: 'win32',
    spawnProcess: fakeSpawn,
  });
  assert.equal(seenExe, 'wsl.exe');
  assert.equal(seenArgs[0], '--');
  assert.equal(seenArgs[1], '/bin/sh');
  assert.equal(seenArgs[2], '-lc');
  assert.match(seenArgs[3], /CLAUDE_CONFIG_DIR='\/tmp\/win-wsl-usage-test'/);
  assert.equal(usage.windows.length, 2);
  assert.equal(usage.windows[0].used, 20);
});
