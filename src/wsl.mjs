// src/wsl.mjs — Windows <-> WSL2 bridge helpers for win32 Magpie hosts.
//
// When Magpie itself runs on native Windows (`process.platform === "win32"`),
// the Claude TUI runtime, tmux and the official Linux Claude CLI run inside
// the user's default WSL2 Linux distribution and bind 127.0.0.1:<port>, which
// WSL2 forwards back to the Windows host.
import { spawn } from "node:child_process";

export const isPrivateFileMode = (mode, os = process.platform) =>
  os === "win32" || (mode & 0o777) === 0o600;

export const isPrivateDirMode = (mode, os = process.platform) =>
  os === "win32" || (mode & 0o777) === 0o700;

// Converts a Windows absolute path (e.g. `C:\Users\alice\.config` or
// `/tmp/test` in cross-platform unit tests) to its WSL mount path
// (`/mnt/c/Users/alice/.config`). Already-POSIX paths starting with `/` are
// returned normalized with forward slashes.
export function toWslPath(winPath) {
  const s = String(winPath ?? "").trim();
  if (!s) throw new Error("WSL path conversion requires a non-empty path");
  const m = s.match(/^([A-Za-z]):[\\/](.*)$/);
  if (m) {
    const drive = m[1].toLowerCase();
    const rest = m[2].replaceAll("\\", "/").replace(/\/+$/, "");
    return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
  }
  if (s.startsWith("/")) return s.replaceAll("\\", "/");
  throw new Error(`Unsupported Windows path for WSL conversion: ${winPath}`);
}

export const wslShellQuote = s => "'" + String(s).replaceAll("'", "'\\''") + "'";

export const wslEnvAssignments = (env = {}) => {
  const parts = [];
  for (const k of [
    "HOME", "PATH", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR",
    "LANG", "LC_ALL", "TERM", "CLAUDE_CONFIG_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    "MAGPIE_CLAUDE_NATIVE_TMUX_GUARD",
  ]) {
    if (env[k] !== undefined && env[k] !== "") {
      parts.push(`${k}=${wslShellQuote(env[k])}`);
    }
  }
  return parts;
};

// Runs a short command inside WSL2 and returns trimmed stdout, or null on failure.
export function runWslCapture(args, { spawnImpl = spawn, timeoutMs = 10_000, env = process.env } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawnImpl("wsl.exe", ["--", ...args], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      return resolve(null);
    }
    const chunks = [];
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", c => chunks.push(c));
    child.once("error", () => { clearTimeout(timer); resolve(null); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      resolve(Buffer.concat(chunks).toString("utf8").trim());
    });
  });
}

// Probes WSL2 availability, architecture, and required Linux binaries (`bun`, `tmux`, `claude`).
export async function probeWslDeps({ spawnImpl = spawn, env = process.env } = {}) {
  const script = [
    'export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    'printf "arch=%s\\n" "$(uname -m)"',
    'for cmd in bun node tmux claude; do printf "%s=%s\\n" "$cmd" "$(command -v "$cmd" 2>/dev/null || true)"; done',
  ].join("; ");
  const out = await runWslCapture(["sh", "-lc", script], { spawnImpl, env });
  if (!out) {
    return { wsl: null, arch: null, bun: null, node: null, tmux: null, claude: null };
  }
  const map = {};
  for (const line of out.split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx > 0) map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim() || null;
  }
  const rawArch = map.arch;
  const arch = rawArch === "aarch64" || rawArch === "arm64" ? "arm64" : "amd64";
  return {
    wsl: "wsl.exe",
    arch,
    bun: map.bun || null,
    node: map.node || null,
    tmux: map.tmux || null,
    claude: map.claude || null,
  };
}
