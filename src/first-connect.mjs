// First-connect orchestration. Loading the plugin has no side effects.
// Only an explicit auth action creates a private profile and opens a terminal.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPrivateFileMode, toWslPath } from './wsl.mjs';

export const DEFAULT_MODELS = ['sonnet', 'opus', 'haiku']; // official CLI aliases, not an account entitlement list
const runner = fileURLToPath(new URL('../scripts/first-connect-runner.mjs', import.meta.url));
export const shellQuote = s => "'" + String(s).replaceAll("'", "'\\''") + "'";

export function privatePath(path, home) {
  const target = resolve(path);
  const realHome = realpathSync(home);
  if (!target.startsWith(realHome + sep)) throw new Error('Setup state must be inside the user home');
  const m = target.match(/^[A-Za-z]:\\/);
  let part = m ? m[0] : sep;
  const rest = m ? target.slice(m[0].length) : target;
  for (const component of rest.split(sep).filter(Boolean)) {
    part = join(part, component);
    try {
      const st = lstatSync(part);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('Setup path must contain only real directories');
      if (part === target && typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('Setup directory has a different owner');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return target;
}
export async function privateDirectory(path, home) {
  privatePath(path, home);
  await mkdir(path, { recursive: true, mode: 0o700 });
  privatePath(path, home);
  await chmod(path, 0o700);
}

export function setupEnvironment(env, home) {
  const clean = {};
  for (const k of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'LANG', 'LC_ALL', 'TERM', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'TMPDIR', 'USER', 'LOGNAME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) {
    if (env[k] !== undefined) clean[k] = env[k];
  }
  clean.HOME = home;
  clean.PATH = [...new Set([dirname(process.execPath), ...(env.PATH || '').split(delimiter), join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean))].join(delimiter);
  return clean; // No ANTHROPIC_*, CLAUDE_CODE_OAUTH_TOKEN, NODE_OPTIONS or API-key helper inheritance.
}
export async function findExecutable(name, env) {
  for (const dir of (env.PATH || '').split(delimiter).filter(Boolean)) {
    const path = join(dir, name);
    try { await access(path, constants.X_OK); return path; } catch {}
  }
  return null;
}

export async function launchTerminal(command, env, { os = process.platform, find = findExecutable, spawnProcess = spawn } = {}) {
  let executable, args;
  if (os === 'darwin') {
    executable = '/usr/bin/osascript';
    // JSON string syntax is also valid for this AppleScript string literal;
    // shell metacharacters live inside individually quoted argv below.
    args = ['-e', 'tell application "Terminal"', '-e', 'activate', '-e', `do script ${JSON.stringify(command)}`, '-e', 'end tell'];
  } else if (os === 'win32') {
    const wt = await find('wt.exe', env);
    if (wt) {
      executable = wt;
      args = ['new-tab', 'wsl.exe', '--', '/bin/sh', '-lc', command];
    } else {
      executable = 'cmd.exe';
      args = ['/c', 'start', '""', 'wsl.exe', '--', '/bin/sh', '-lc', command];
    }
  } else if (os === 'linux' && (env.DISPLAY || env.WAYLAND_DISPLAY)) {
    for (const [name, prefix] of [['x-terminal-emulator', ['-e']], ['gnome-terminal', ['--']], ['konsole', ['-e']], ['xfce4-terminal', ['-x']], ['xterm', ['-e']]]) {
      executable = await find(name, env);
      if (executable) { args = [...prefix, '/bin/sh', '-c', command]; break; }
    }
  }
  if (!executable) return false; // SSH/headless: the host displays the exact command instead.
  await new Promise((resolveLaunch, reject) => {
    const child = spawnProcess(executable, args, { env, stdio: 'ignore' });
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Opening the setup terminal timed out')); }, 15000);
    const done = fn => value => { clearTimeout(timeout); fn(value); };
    child.once('error', done(reject));
    child.once('spawn', () => {
      if (os !== 'darwin') { child.unref?.(); done(resolveLaunch)(); }
    });
    child.once('exit', code => code === 0 ? done(resolveLaunch)() : done(reject)(new Error('Could not open the setup terminal. Allow Magpie to control Terminal, or run the displayed setup command.')));
  });
  return true;
}

export async function beginFirstConnect({ home, stateRoot, env, os = process.platform, wslDeps, terminal = launchTerminal, timeoutMs = 9 * 60 * 1000, pollMs = 300, now = Date.now }) {
  const clean = setupEnvironment(env, home);
  let wslInfo = null;
  if (os === 'win32') {
    wslInfo = wslDeps ? await wslDeps() : null;
    if (wslInfo && !wslInfo.claude) throw new Error('未在 WSL2 中找到 Claude Code。请先在 WSL2 终端安装官方 Claude Code，再重新连接。');
    if (wslInfo && !(wslInfo.bun || wslInfo.node)) throw new Error('未在 WSL2 中找到 bun 或 node。请先在 WSL2 终端安装 bun 或 Node.js >= 18，再重新连接。');
  } else if (!await findExecutable('claude', clean)) {
    throw new Error('未找到 Claude Code。请先安装官方 Claude Code，再重新连接。');
  }
  const session = join(stateRoot, 'setup', randomBytes(16).toString('hex'));
  await privateDirectory(session, home);
  const configFile = join(session, 'setup.json');
  const resultFile = join(session, 'result.json');
  const heartbeat = join(session, 'heartbeat');
  const cancelFile = join(session, 'cancel');
  const profile = join(session, 'claude');
  const isWin = os === 'win32';
  const targetHome = isWin ? toWslPath(home) : home;
  const targetSession = isWin ? toWslPath(session) : session;
  const targetConfigFile = isWin ? `${targetSession}/setup.json` : configFile;
  const targetProfile = isWin ? `${targetSession}/claude` : profile;
  const targetEnv = isWin
    ? { ...clean, HOME: targetHome, PATH: '$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin' }
    : clean;
  const config = {
    v: 1,
    home: targetHome,
    profile: targetProfile,
    resultFile: isWin ? `${targetSession}/result.json` : resultFile,
    heartbeat: isWin ? `${targetSession}/heartbeat` : heartbeat,
    cancelFile: isWin ? `${targetSession}/cancel` : cancelFile,
    environment: targetEnv,
    deadline: now() + timeoutMs,
  };
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
  await writeFile(heartbeat, '', { mode: 0o600, flag: 'wx' });
  // The launched terminal inherits the user's shell; scrub its environment
  // again with env -i. Proxy/certificate values stay in the private config,
  // never in terminal command text or process argv.
  const targetRunner = isWin ? toWslPath(runner) : runner;
  const targetSshLogin = isWin ? toWslPath(fileURLToPath(new URL('../scripts/ssh-login.mjs', import.meta.url))) : fileURLToPath(new URL('../scripts/ssh-login.mjs', import.meta.url));
  const targetExec = isWin ? (wslInfo?.bun || wslInfo?.node || 'bun') : process.execPath;
  const prefix = ['/usr/bin/env', '-i', `HOME=${targetHome}`, `PATH=${isWin ? '/usr/local/bin:/usr/bin:/bin' : clean.PATH}`, targetExec];
  let command = [...prefix, targetRunner, targetConfigFile].map(shellQuote).join(' ');
  let opened = false;
  try { opened = await terminal(command, clean, { os }); } catch { /* Display a manual fallback instead of losing the flow. */ }
  if (!opened) {
    const inner = [...prefix, targetSshLogin, targetConfigFile, 'start'].map(shellQuote).join(' ');
    command = isWin ? `wsl.exe -- /bin/sh -lc ${shellQuote(inner)}` : inner;
  }
  let settled = false;
  const pulse = setInterval(() => writeFile(heartbeat, '', { mode: 0o600 }).catch(() => {}), 2000);
  pulse.unref?.();
  async function finish() {
    if (settled) throw new Error('This setup flow has already completed');
    settled = true;
    try {
      while (now() < config.deadline) {
        try {
          const st = lstatSync(resultFile);
          if (!st.isFile() || st.isSymbolicLink() || !isPrivateFileMode(st.mode, os)) throw new Error('Invalid private setup result');
          const result = JSON.parse(await readFile(resultFile, 'utf8'));
          if (result.v !== 1 || (result.profile !== profile && result.profile !== targetProfile)) throw new Error('Setup result did not match this sign-in');
          if (!result.ok) throw new Error(result.error || 'Claude 登录未完成，请重新连接。');
          return { profile, models: [...DEFAULT_MODELS] };
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
        await new Promise(r => setTimeout(r, pollMs));
      }
      throw new Error('安装或登录已超时。请关闭安装终端后重新连接；原账号配置没有被覆盖。');
    } finally {
      clearInterval(pulse);
      await writeFile(cancelFile, '', { mode: 0o600 }).catch(() => {});
    }
  }
  // Expire abandoned GUI sign-ins even when callback is never invoked.
  const expiry = setTimeout(() => { clearInterval(pulse); writeFile(cancelFile, '', { mode: 0o600 }).catch(() => {}); }, timeoutMs);
  expiry.unref?.();
  return { profile, command, opened, async finish() { try { return await finish(); } finally { clearTimeout(expiry); } } };
}
