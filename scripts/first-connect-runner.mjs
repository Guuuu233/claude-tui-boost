// Runs inside a real user terminal, never in Magpie's JSON-RPC stdout.
// No credentials are captured: Claude owns OAuth and its dedicated profile.
import { spawn } from 'node:child_process';
import { lstat, readFile, writeFile, rename, stat, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findExecutable, privateDirectory, privatePath, setupEnvironment } from '../src/first-connect.mjs';

export function installPlan(os, found, uid = process.getuid?.()) {
  if (found.brew) return [found.brew, ['install', 'tmux']];
  if (os === 'linux') {
    const manager = found['apt-get'] || found.dnf || found.pacman;
    if (manager) {
      const args = found['apt-get'] === manager ? ['install', '-y', 'tmux'] : found.dnf === manager ? ['install', '-y', 'tmux'] : ['-S', '--needed', '--noconfirm', 'tmux'];
      if (uid === 0) return [manager, args];
      if (found.sudo) return [found.sudo, [manager, ...args]];
    }
  }
  throw new Error('缺少 tmux，且没有可用的系统包管理器。macOS 请先安装 Homebrew；Linux 请先安装 tmux，然后重新连接。');
}

export function validSubscriptionStatus(status, profile) {
  if (!status || status.loggedIn !== true || !['claude.ai', 'oauth_token'].includes(status.authMethod)) return false;
  return typeof status.configDirectory === 'string' && resolve(status.configDirectory) === resolve(profile);
}

export async function runSetup(config, { env = process.env, find = findExecutable, run, os = process.platform, say = console.log, onPhase = async () => {}, prepareOnly = false } = {}) {
  if (config.v !== 1 || !Number.isFinite(config.deadline) || config.deadline < Date.now()) throw new Error('Setup expired');
  if (config.home !== env.HOME) throw new Error('Setup HOME mismatch');
  await privateDirectory(config.profile, config.home);
  const clean = setupEnvironment(env, config.home);
  clean.CLAUDE_CONFIG_DIR = config.profile;
  const claude = await find('claude', clean);
  if (!claude) throw new Error('未找到 Claude Code，请先安装后重试。');
  await onPhase("preparing");
  if (!await find('tmux', clean)) {
    const found = Object.fromEntries(await Promise.all(['brew', 'apt-get', 'dnf', 'pacman', 'sudo'].map(async n => [n, await find(n, clean)])));
    if (os === 'darwin' && !found.brew) {
      say('未检测到 Homebrew。将运行 Homebrew 官方安装器；请阅读终端中的系统变更说明，按其提示确认或取消。');
      const curl = await find('curl', clean);
      if (!curl) throw new Error('未找到系统 curl，无法准备 Homebrew。请先安装 tmux 后重新连接。');
      const installer = join(dirname(config.profile), 'homebrew-install.sh');
      await writeFile(installer, '', { flag: 'wx', mode: 0o600 });
      await run(curl, ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '15', '--max-time', '60', '--output', installer, 'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh'], { env: clean });
      await run('/bin/bash', [installer], { env: clean });
      found.brew = await find('brew', clean);
    }
    const [bin, args] = installPlan(os, found);
    say('正在安装 tmux；如系统要求，请在此终端输入管理员密码。');
    await run(bin, args, { env: clean });
    if (!await find('tmux', clean)) throw new Error('tmux 安装未成功，请检查终端中的包管理器输出。');
  }
  if (prepareOnly) return { prepared: true };
  const status = async () => {
    try { return JSON.parse(await run(claude, ['auth', 'status', '--json'], { env: clean, capture: true })); } catch { return null; }
  };
  say('使用插件专用 Claude 配置目录；不会复制或覆盖已有 Claude 登录。');
  if (!validSubscriptionStatus(await status(), config.profile)) {
    say('正在打开官方 Claude 登录。请完成浏览器授权；如出现授权码提示，请粘贴到此终端。');
    await onPhase('login');
    await run(claude, ['auth', 'login', '--claudeai'], { env: clean });
  }
  await onPhase('verifying');
  if (!validSubscriptionStatus(await status(), config.profile)) throw new Error('无法确认专用目录的 Claude 订阅登录。请更新 Claude Code（需支持 auth status 的 configDirectory 字段），并使用 Claude 订阅登录。');
  say('Claude 登录已验证，正在连接 Magpie。可返回 Magpie 查看连接结果。');
  return { v: 1, ok: true, profile: config.profile };
}

export async function readSetupConfig(configPath, env = process.env) {
  const st = await lstat(configPath);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o600) throw new Error('Setup config is not a private regular file');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const session = dirname(configPath);
  privatePath(session, config.home);
  for (const [name, file] of [['profile', 'claude'], ['resultFile', 'result.json'], ['heartbeat', 'heartbeat'], ['cancelFile', 'cancel']]) {
    if (config[name] !== join(session, file)) throw new Error('Setup path mismatch');
  }
  if (config.home !== env.HOME) throw new Error('Setup HOME mismatch');
  return config;
}

async function main(configPath, prepareOnly = false) {
  const config = await readSetupConfig(configPath);
  const session = dirname(configPath);
  try { await lstat(config.cancelFile); throw new Error('安装已取消，请重新连接。'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (Date.now() - (await stat(config.heartbeat)).mtimeMs > 12000) throw new Error('Magpie 安装会话已结束，请重新连接。');
  // A late-opened terminal and the manual fallback must never start two logins.
  if (!prepareOnly) await mkdir(join(session, 'running'), { mode: 0o700 });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop); process.once('SIGHUP', stop);
  const timer = setInterval(async () => {
    try {
      await lstat(config.cancelFile); stop();
    } catch (e) { if (e.code !== 'ENOENT') stop(); }
    try { if (Date.now() > config.deadline || Date.now() - (await stat(config.heartbeat)).mtimeMs > 12000) stop(); } catch { stop(); }
  }, 1000);
  timer.unref();
  const run = (file, args, { env, capture = false }) => new Promise((res, rej) => {
    if (controller.signal.aborted) return rej(new Error('安装或登录已取消。'));
    let output = '';
    const child = spawn(file, args, { env, cwd: session, stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'inherit' });
    let force;
    const terminate = () => { child.kill('SIGTERM'); force = setTimeout(() => child.kill('SIGKILL'), 2000); force.unref(); };
    const limit = setTimeout(terminate, capture ? 15000 : Math.max(1, config.deadline - Date.now()));
    const abort = terminate;
    controller.signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(limit); clearTimeout(force); controller.signal.removeEventListener('abort', abort); };
    if (capture) child.stdout.on('data', data => { output += data; if (output.length > 65536) child.kill('SIGTERM'); });
    child.once('error', error => { cleanup(); rej(error); });
    child.once('close', code => { cleanup(); code === 0 ? res(output) : rej(new Error(controller.signal.aborted ? '安装或登录已取消。' : '安装或 Claude 登录失败，请查看终端输出后重新连接。')); });
  });
  let result;
  try { result = await runSetup(config, { run, env: config.environment, prepareOnly,
    onPhase: async phase => {
      const tmp = join(session, 'progress.tmp');
      await writeFile(tmp, JSON.stringify({ phase, updatedAt: Date.now() }), { mode: 0o600 });
      await rename(tmp, join(session, 'progress.json'));
    },
  }); }
  catch (e) { result = { v: 1, ok: false, profile: config.profile, error: e.message }; console.error(e.message); }
  finally { clearInterval(timer); }
  if (prepareOnly && result.prepared) return;
  // A fresh setup owns this result; publish atomically and never serialize auth status or OAuth tokens.
  const tmp = join(session, 'result.tmp');
  await writeFile(tmp, JSON.stringify(result), { mode: 0o600, flag: 'wx' });
  await rename(tmp, config.resultFile);
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2], process.argv[3] === '--prepare-only').catch(e => { console.error(e.message); process.exitCode = 1; });
}
