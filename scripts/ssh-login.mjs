// Own one detached tmux server per first-connect attempt. Never expose a web
// service, open firewall ports, export credentials, or operate default tmux.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, chmod, readFile, writeFile, rename, rm, stat, link } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { findExecutable, setupEnvironment, shellQuote } from '../src/first-connect.mjs';
import { readSetupConfig } from './first-connect-runner.mjs';

const self = fileURLToPath(import.meta.url);
const runner = fileURLToPath(new URL('./first-connect-runner.mjs', import.meta.url));
const delay = ms => new Promise(r => setTimeout(r, ms));
const ownerOf = path => createHash('sha256').update(resolve(path)).digest('hex');
const integrityError = error => /^(Invalid private|Remote tmux owner mismatch|Remote login identity mismatch)/.test(error.message);
const cleanText = text => text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
export function authorizationURL(text) {
  const matches = cleanText(String(text)).match(/https:\/\/[^\s<>"']+/g) || [];
  for (const candidate of matches) {
    try {
      const value = candidate.replace(/[),.;]+$/, ''); const url = new URL(value);
      if ((['claude.ai', 'platform.claude.com', 'console.anthropic.com'].includes(url.hostname) && url.pathname === '/oauth/authorize' || url.hostname === 'claude.com' && url.pathname === '/cai/oauth/authorize') && !url.username && !url.password && !url.port &&
          url.searchParams.has('state') && url.searchParams.has('code_challenge')) return value;
    } catch {}
  }
  return null;
}
async function json(path) {
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o600) throw new Error('Invalid private login state');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function atomic(path, value) {
  const temp = path + '.tmp';
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await rename(temp, path);
}
async function command(file, args, { env, input, inherit = false, timeout = 10000 } = {}) {
  return new Promise((res, rej) => {
    const child = spawn(file, args, { env, stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    if (!inherit) { child.stdin.on('error', () => {}); child.stdout.on('data', d => { output += d; if (output.length > (1 << 20)) child.kill('SIGKILL'); }); child.stdin.end(input); }
    child.once('error', e => { clearTimeout(timer); rej(e); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? res(output) : rej(new Error('Remote login command failed; inspect status or attach to its private terminal.')); });
  });
}
async function context(configPath, env = process.env) {
  const config = await readSetupConfig(configPath, env);
  const clean = setupEnvironment(config.environment, config.home);
  const tmux = await findExecutable('tmux', clean);
  return { config, env: clean, tmux, dir: dirname(configPath), path: resolve(configPath), owner: ownerOf(configPath) };
}
async function descriptor(ctx) {
  const value = await json(join(ctx.dir, 'remote.json'));
  const tempRoot = realpathSync('/tmp');
  if (value.owner !== ctx.owner || value.session !== 'login' || typeof value.socket !== 'string' ||
      dirname(value.socket) !== join(tempRoot, value.socketDir) || !/^mgtui-login-[A-Za-z0-9]+$/.test(value.socketDir) ||
      value.socket !== join(tempRoot, value.socketDir, 'socket')) throw new Error('Remote login identity mismatch');
  return value;
}
const tm = (ctx, d, args, opts = {}) => command(ctx.tmux, ['-S', d.socket, ...args], { env: ctx.env, ...opts });
async function verifyServer(ctx, d) {
  if (!ctx.tmux) throw new Error('tmux is unavailable');
  const st = await lstat(dirname(d.socket));
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o700 || (process.getuid && st.uid !== process.getuid())) throw new Error('Invalid private tmux directory');
  if ((await tm(ctx, d, ['show-options', '-gv', '@magpie-setup-owner'])).trim() !== ctx.owner) throw new Error('Remote tmux owner mismatch');
}
export async function remoteStatus(configPath, { env = process.env } = {}) {
  const ctx = await context(configPath, env);
  try {
    const result = await json(ctx.config.resultFile);
    if (result.profile !== ctx.config.profile || result.v !== 1) throw new Error('Remote login result mismatch');
    return { phase: result.ok ? 'authenticated' : 'failed', message: result.ok ? 'Claude 登录已验证；等待 Magpie 完成 Runtime 连接检查。' : result.error };
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (Date.now() > ctx.config.deadline) return { phase: 'expired', message: '登录已过期，请在 Magpie 重新发起连接。' };
  try { await lstat(ctx.config.cancelFile); return { phase: 'canceled', message: '登录已取消。' }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let d;
  try { d = await descriptor(ctx); } catch (e) { if (e.code === 'ENOENT') return { phase: 'preparing', message: '尚未启动远程登录；执行 start 命令准备依赖。' }; throw e; }
  try {
    await verifyServer(ctx, d);
    const dead = (await tm(ctx, d, ['display-message', '-p', '-t', 'login:0.0', '#{pane_dead}'])).trim();
    if (dead === '1') return { phase: 'failed', message: '登录进程已退出且未验证成功；请重新发起连接，不要重放授权码。' };
    const progress = await json(join(ctx.dir, 'progress.json')).catch(e => { if (e.code !== 'ENOENT') throw e; return {}; });
    if (progress.phase === 'login') {
      try { await lstat(join(ctx.dir, 'code-submitted')); return { phase: 'verifying_authorization', message: '已提交授权码，等待官方 CLI 验证，不要重复提交。' }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const screen = await tm(ctx, d, ['capture-pane', '-p', '-J', '-t', 'login:0.0', '-S', '-100']);
      const url = authorizationURL(screen);
      return { phase: url ? 'waiting_authorization' : 'starting_login', ...(url ? { authorizationURL: url } : {}),
        message: url ? '将 authorizationURL 转交用户，在用户本机浏览器完成授权。若网页给出授权码，通过 code 命令的标准输入提交；不要打开 localhost 回调地址。' : '等待官方 CLI 输出授权链接；必要时使用 attach 查看提示。' };
    }
    return { phase: progress.phase || 'starting', message: '正在准备或核对登录状态。' };
  } catch (e) {
    if (integrityError(e)) throw e;
    return { phase: 'interrupted', message: '远程登录进程不存在。请在 Magpie 重新连接，不要重放旧授权码。' };
  }
}
export async function cancelRemote(configPath, { env = process.env } = {}) {
  const ctx = await context(configPath, env);
  await writeFile(ctx.config.cancelFile, '', { mode: 0o600 });
  return { phase: 'canceled' };
}
export async function submitCode(configPath, code, { env = process.env } = {}) {
  const value = String(code).replace(/\r?\n$/, '');
  if (!value || value.length > 4096 || /[^\x21-\x7e]/.test(value) || /^(?:https?:|sk-ant-|sk-[A-Za-z0-9]|eyJ[A-Za-z0-9_-]*\.)/i.test(value)) throw new Error('请输入官方网页显示的单行授权码，不是回调网址、密码或令牌。');
  const ctx = await context(configPath, env);
  const state = await remoteStatus(configPath, { env });
  if (state.phase !== 'waiting_authorization') throw new Error('当前会话不在等待授权，拒绝提交或重放授权码。');
  const d = await descriptor(ctx); await verifyServer(ctx, d);
  await writeFile(join(ctx.dir, 'code-submitted'), '', { flag: 'wx', mode: 0o600 }).catch(e => { if (e.code === 'EEXIST') throw new Error('本次授权码已提交，请等待结果，不要重放。'); throw e; });
  // The code travels on stdin to a private tmux buffer, never in shell text,
  // argv, JSON status or the plugin's connection key. Paste deletes the buffer.
  await tm(ctx, d, ['load-buffer', '-b', 'oauth-code', '-'], { input: value });
  try { await tm(ctx, d, ['paste-buffer', '-d', '-b', 'oauth-code', '-t', 'login:0.0']); await tm(ctx, d, ['send-keys', '-t', 'login:0.0', 'Enter']); }
  finally { await tm(ctx, d, ['delete-buffer', '-b', 'oauth-code']).catch(() => {}); }
  return { phase: 'code_submitted', message: '授权码已交给官方 CLI，等待验证；不要重复提交。' };
}
async function cleanup(ctx, d) {
  try { await verifyServer(ctx, d); await tm(ctx, d, ['kill-server']); }
  catch (e) { if (integrityError(e)) throw e; }
  // Only the unique private socket directory created for this attempt.
  await rm(dirname(d.socket), { recursive: true, force: true });
}
export async function startRemote(configPath, { env = process.env } = {}) {
  let ctx = await context(configPath, env);
  const state = await remoteStatus(configPath, { env });
  if (['authenticated', 'failed', 'expired', 'canceled', 'interrupted'].includes(state.phase)) return state;
  try { await descriptor(ctx); return state; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // An uncertain interrupted dependency installation must not be duplicated.
  try { await mkdir(join(ctx.dir, 'remote-start'), { mode: 0o700 }); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('此连接正在准备依赖或上次准备已中断。先检查依赖；请勿重复启动，必要时在 Magpie 新建连接。'); throw e; }
  if (!ctx.tmux) {
    console.log('正在准备 tmux。需要 sudo 时请使用 ssh -tt，并在 SSH 终端输入系统密码。');
    await command(process.execPath, [runner, ctx.path, '--prepare-only'], { env: { ...ctx.env, HOME: ctx.config.home }, inherit: true, timeout: Math.max(1, ctx.config.deadline - Date.now()) });
    ctx = await context(configPath, env);
    if (!ctx.tmux) throw new Error('tmux 安装失败，请检查系统包管理器。');
  }
  const socketRoot = await mkdtemp(join(realpathSync('/tmp'), 'mgtui-login-')); await chmod(socketRoot, 0o700);
  const d = { owner: ctx.owner, session: 'login', socket: join(socketRoot, 'socket'), socketDir: socketRoot.slice(realpathSync('/tmp').length + 1) };
  const tmuxConfig = join(ctx.dir, 'tmux.conf');
  await writeFile(tmuxConfig, `set -g remain-on-exit off\nset -g history-limit 100\nset -g @magpie-setup-owner ${ctx.owner}\n`, { flag: 'wx', mode: 0o600 });
  const argv = ['/usr/bin/env', '-i', `HOME=${ctx.config.home}`, `PATH=${ctx.env.PATH}`, 'TERM=xterm-256color', process.execPath, runner, ctx.path];
  const launch = 'exec ' + argv.map(shellQuote).join(' ');
  try {
    await command(ctx.tmux, ['-S', d.socket, '-f', tmuxConfig, 'new-session', '-d', '-s', 'login', '-x', '4096', '-y', '32', launch], { env: ctx.env });
    await verifyServer(ctx, d);
    await atomic(join(ctx.dir, 'remote.json'), d);
    // Watcher is detached from SSH and cleans this exact server on finish,
    // cancellation, parent-host loss or the bounded sign-in deadline.
    const watcher = spawn(process.execPath, [self, ctx.path, 'watch'], { env: { ...ctx.env, HOME: ctx.config.home }, detached: true, stdio: 'ignore' });
    await new Promise((res, rej) => { watcher.once('spawn', res); watcher.once('error', rej); }); watcher.unref();
    return await remoteStatus(configPath, { env });
  } catch (e) { await cleanup(ctx, d); throw e; }
}
async function watch(configPath) {
  const ctx = await context(configPath); const d = await descriptor(ctx);
  try {
    while (Date.now() < ctx.config.deadline) {
      const state = await remoteStatus(configPath);
      if (['authenticated', 'failed', 'expired', 'canceled', 'interrupted'].includes(state.phase)) {
        if (state.phase === 'interrupted') {
          // Atomic create-if-absent: never overwrite a result the runner may
          // already have published in the meantime.
          const failFile = join(ctx.dir, 'interrupted-result.json');
          await atomic(failFile, { v: 1, ok: false, profile: ctx.config.profile, error: state.message });
          await link(failFile, ctx.config.resultFile).catch(e => { if (e.code !== 'EEXIST') throw e; });
        }
        return;
      }
      if (Date.now() - (await stat(ctx.config.heartbeat)).mtimeMs > 12000) { await cancelRemote(configPath); return; }
      await delay(500);
    }
    await cancelRemote(configPath);
  } finally {
    // Give runner time to publish a canceled result and terminate its exact child.
    await delay(2500); await cleanup(ctx, d);
  }
}
function controlCommands(configPath, env = process.env) {
  const prefix = [process.execPath, self, resolve(configPath)].map(shellQuote).join(' ');
  return Object.fromEntries(['status', 'code', 'attach', 'cancel'].map(action => [action, prefix + ' ' + action]));
}
async function monitor(configPath) {
  let stopped = false, previous = ''; const input = createInterface({ input: process.stdin, terminal: false });
  process.once('SIGHUP', () => { stopped = true; input.close(); });
  process.once('SIGTERM', () => { stopped = true; input.close(); });
  process.once('SIGINT', () => { cancelRemote(configPath).catch(() => {}); stopped = true; input.close(); });
  input.on('line', line => { if (line.trim()) submitCode(configPath, line).then(s => console.log(JSON.stringify(s)), e => console.error(e.message)); });
  console.log(JSON.stringify({ commands: controlCommands(configPath), codeInput: 'stdin only; never put a code in arguments' }));
  console.log('SSH 断开不会终止后台登录；可再次运行本命令查看进度。授权码只从标准输入提交，不要写入命令参数。');
  try {
    while (!stopped) {
      const state = await remoteStatus(configPath); const serialized = JSON.stringify(state);
      if (serialized !== previous) { console.log(serialized); previous = serialized; }
      if (['authenticated', 'failed', 'expired', 'canceled', 'interrupted'].includes(state.phase)) { if (state.phase !== 'authenticated') process.exitCode = 1; return; }
      await delay(500);
    }
  } finally { input.close(); }
}
async function main(configPath, action = 'start') {
  if (action === 'status') return console.log(JSON.stringify(await remoteStatus(configPath)));
  if (action === 'cancel') return console.log(JSON.stringify(await cancelRemote(configPath)));
  if (action === 'code') {
    let code = ''; for await (const chunk of process.stdin) { code += chunk; if (code.length > 4097) throw new Error('授权码过长。'); }
    return console.log(JSON.stringify(await submitCode(configPath, code)));
  }
  if (action === 'watch') return watch(configPath);
  if (action === 'attach') {
    const ctx = await context(configPath); const d = await descriptor(ctx); await verifyServer(ctx, d);
    return command(ctx.tmux, ['-S', d.socket, 'attach-session', '-t', 'login'], { env: ctx.env, inherit: true, timeout: Math.max(1, ctx.config.deadline - Date.now()) });
  }
  if (action === 'start-detached') { await startRemote(configPath); return console.log(JSON.stringify({ ...await remoteStatus(configPath), commands: controlCommands(configPath) })); }
  if (action !== 'start') throw new Error('Use start, start-detached, status, code (stdin), attach or cancel');
  await startRemote(configPath); return monitor(configPath);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (['--help', '-h'].includes(process.argv[2])) { console.log('Usage: bun scripts/ssh-login.mjs <private setup.json> start|start-detached|status|code|attach|cancel\ncode reads one authorization code from stdin, never an argument.'); }
  else main(process.argv[2], process.argv[3]).catch(e => { console.error(e.message); process.exitCode = 1; });
}
