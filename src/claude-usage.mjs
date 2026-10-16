import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { findExecutable, setupEnvironment } from "./first-connect.mjs";

const usageLine = /^Current (session|week(?: \(([^)]+)\))?):\s*([0-9]+(?:\.[0-9]+)?)% used(?:\s*·\s*resets (.+))?$/;
const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const denied = /\b(401|403)\b|not (?:logged|signed) in|signed out|sign-in (?:has )?expired|unauthorized|forbidden|authentication (?:failed|required)|invalid (?:access )?token/i;
const maxOutputBytes = 64 * 1024;
const usageEndpoint = "https://api.anthropic.com/api/oauth/usage";
const usageCacheTtlMs = 60_000;
const usageCache = new Map();
const usageInFlight = new Map();

function zoneParts(date, timeZone) {
  if (!timeZone) {
    return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { year: Number(value.year), month: Number(value.month) - 1, day: Number(value.day) };
}

function zonedDate(year, month, day, hour, minute, timeZone) {
  if (!timeZone) return new Date(year, month, day, hour, minute, 0, 0);
  let guess = Date.UTC(year, month, day, hour, minute);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23",
  });
  const target = Date.UTC(year, month, day, hour, minute);
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(part => [part.type, Number(part.value)]));
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    guess += target - actual;
  }
  return new Date(guess);
}

function parseClock(hourText, minuteText, meridiem) {
  let hour = Number(hourText);
  const minute = Number(minuteText ?? 0);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (meridiem.toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (meridiem.toLowerCase() === "am" && hour === 12) hour = 0;
  return { hour, minute };
}

function resetTime(raw, now, spanSeconds) {
  if (!raw) return undefined;
  let value = raw.trim();
  let timeZone;
  const zoneAt = value.lastIndexOf(" (");
  if (zoneAt >= 0 && value.endsWith(")")) {
    timeZone = value.slice(zoneAt + 2, -1);
    value = value.slice(0, zoneAt).trim();
  }

  let dateParts;
  let clock;
  let explicitYear;
  const dated = value.match(/^([A-Za-z]{3})\s+(\d{1,2})(?:,\s*(\d{4}))?(?:\s+at\s+|,\s*)(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (dated) {
    const month = new Date(`${dated[1]} 1, 2000`).getMonth();
    if (month < 0) return undefined;
    dateParts = { month, day: Number(dated[2]) };
    explicitYear = dated[3] ? Number(dated[3]) : undefined;
    clock = parseClock(dated[4], dated[5], dated[6]);
  } else {
    const timed = value.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
    if (!timed) return undefined;
    dateParts = zoneParts(now, timeZone);
    clock = parseClock(timed[1], timed[2], timed[3]);
  }
  if (!clock) return undefined;

  const current = zoneParts(now, timeZone);
  const year = explicitYear ?? current.year;
  const candidateFor = y => zonedDate(y, dateParts.month, dateParts.day, clock.hour, clock.minute, timeZone);
  let candidate = candidateFor(year);
  const maxFuture = now.getTime() + (spanSeconds + 2 * 60 * 60) * 1000;

  if (!explicitYear && candidate.getTime() < now.getTime() - (spanSeconds + 2 * 60 * 60) * 1000) {
    const nextYear = candidateFor(year + 1);
    if (nextYear.getTime() <= maxFuture) candidate = nextYear;
  }
  if (!explicitYear && candidate.getTime() > maxFuture) {
    const previousYear = candidateFor(year - 1);
    if (previousYear.getTime() <= now.getTime()) candidate = previousYear;
    else return undefined;
  }
  return Number.isFinite(candidate.getTime()) ? candidate.toISOString() : undefined;
}

export function parseClaudeUsage(output, now = new Date()) {
  const text = String(output ?? "").replace(ansi, "").trim();
  const lines = text.split(/\r?\n/).map(line => line.trim());
  for (const line of lines) {
    if (denied.test(line)) throw new Error("Claude Code is not signed in to this profile or its usage access was refused");
  }

  const windows = [];
  for (const line of lines) {
    const match = line.match(usageLine);
    if (!match) continue;
    const used = Number(match[3]);
    if (!Number.isFinite(used) || used < 0 || used > 100) continue;
    const isSession = match[1] === "session";
    const scope = match[2]?.trim();
    const span = isSession ? 5 * 60 * 60 : 7 * 24 * 60 * 60;
    let name = isSession ? "5 hours" : "7 days";
    if (!isSession && scope && !/^all models$/i.test(scope)) name += ` · ${scope}`;
    if (windows.some(window => window.name === name)) continue;
    const resetsAt = resetTime(match[4], now, span);
    windows.push({ name, used, span, ...(resetsAt ? { resetsAt } : {}) });
  }

  if (!windows.length) {
    if (/You are currently using your subscription to power your Claude Code usage/i.test(text)) {
      throw new Error("Claude Code /usage did not provide allowance data for this account");
    }
    throw new Error("Claude Code /usage returned no readable quota windows");
  }
  return { windows };
}

function runUsageCommand(executable, profileDir, env, {
  spawnProcess = spawn,
  timeoutMs = 15_000,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(executable, ["-p", "/usage"], {
        cwd: env.HOME,
        env: { ...env, CLAUDE_CONFIG_DIR: profileDir },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      reject(new Error("Could not start Claude Code /usage"));
      return;
    }

    const chunks = [];
    let size = 0;
    let failure;
    let killTimer;
    const timeout = setTimeout(() => {
      failure = "Claude Code /usage timed out";
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref?.();
    }, timeoutMs);
    const collect = chunk => {
      size += chunk.byteLength;
      if (size > maxOutputBytes) {
        failure = "Claude Code /usage output exceeded its safety limit";
        child.kill("SIGTERM");
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", () => {}); // drain without logging account details
    child.once("error", error => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      reject(error?.code === "ENOENT"
        ? new Error("Claude Code CLI was not found on the Magpie host")
        : new Error("Could not start Claude Code /usage"));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      if (failure) return reject(new Error(failure));
      if (code !== 0) return reject(new Error(`Claude Code /usage exited unsuccessfully${code === null ? ` (${signal ?? "unknown signal"})` : ` (code ${code})`}`));
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function apiUsageWindows(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Claude usage endpoint returned unreadable quota data");
  }
  const fields = [
    ["five_hour", "5 hours", 5 * 60 * 60],
    ["seven_day", "7 days", 7 * 24 * 60 * 60],
    ["seven_day_sonnet", "7 days · Sonnet", 7 * 24 * 60 * 60],
    ["seven_day_opus", "7 days · Opus", 7 * 24 * 60 * 60],
  ];
  const windows = [];
  for (const [key, name, span] of fields) {
    const value = payload[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const used = value.utilization;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) continue;
    const reset = typeof value.resets_at === "string" ? Date.parse(value.resets_at) : NaN;
    windows.push({
      name,
      used,
      span,
      ...(Number.isFinite(reset) ? { resetsAt: new Date(reset).toISOString() } : {}),
    });
  }
  if (!windows.length) throw new Error("Claude usage endpoint returned no readable quota windows");
  return windows;
}

async function readProfileAccessToken(profileDir) {
  let raw;
  try {
    raw = await readFile(join(profileDir, ".credentials.json"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error("Could not read Claude profile credentials safely");
  }
  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch {
    throw new Error("Claude profile credentials are unreadable");
  }
  const token = credentials?.claudeAiOauth?.accessToken;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

async function readUsageFromEndpoint(accessToken, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Claude usage endpoint is unavailable on this host");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(usageEndpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "User-Agent": "magpie-claude-tui-plugin",
      },
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    throw new Error(controller.signal.aborted
      ? "Claude usage endpoint request timed out"
      : "Could not connect to Claude usage endpoint");
  }
  if (response.status === 401 || response.status === 403) {
    clearTimeout(timer);
    throw new Error("Claude OAuth access token was expired or rejected");
  }
  if (response.status === 429) {
    clearTimeout(timer);
    throw new Error("Claude usage endpoint rate-limited the request");
  }
  if (!response.ok) {
    clearTimeout(timer);
    throw new Error(`Claude usage endpoint returned HTTP ${response.status}`);
  }
  let raw;
  try {
    raw = await response.text();
  } catch {
    clearTimeout(timer);
    throw new Error(controller.signal.aborted
      ? "Claude usage endpoint request timed out"
      : "Claude usage endpoint response could not be read");
  }
  clearTimeout(timer);
  if (Buffer.byteLength(raw, "utf8") > maxOutputBytes) {
    throw new Error("Claude usage endpoint response exceeded its safety limit");
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("Claude usage endpoint returned unreadable quota data");
  }
  return { windows: apiUsageWindows(payload) };
}

async function readUsageUncached({ profileDir, env, command, spawnProcess, timeoutMs, fetchImpl, usageMode }) {
  if (usageMode === 'direct') {
    const token = await readProfileAccessToken(profileDir);
    if (!token) throw new Error('Explicit direct quota mode requires a readable profile OAuth token');
    return readUsageFromEndpoint(token, { fetchImpl, timeoutMs });
  }
  if (usageMode !== 'native') throw new Error('Unknown Claude usage mode');

  // Default to the official Claude Code /usage behavior on every platform.
  // Merely having an OAuth token in the profile is not authorization for
  // this plugin to issue its own direct usage requests.
  const home = env.HOME || homedir();
  const cliEnv = setupEnvironment(env, home);
  let executable = command;
  if (!executable) executable = await findExecutable("claude", cliEnv) ?? "claude";
  const output = await runUsageCommand(executable, profileDir, cliEnv, { spawnProcess, timeoutMs });
  return parseClaudeUsage(output);
}

export async function readClaudeUsage({
  profileDir,
  env = process.env,
  command,
  spawnProcess,
  timeoutMs,
  fetchImpl,
  usageMode = 'native',
} = {}) {
  if (typeof profileDir !== "string" || !isAbsolute(profileDir)) {
    return { windows: [], error: "Claude profile directory must be an absolute path" };
  }
  // Different transports are not interchangeable caches: one may be stale
  // or unavailable while the other has an independently sourced reading.
  const key = resolve(profileDir) + '\0' + usageMode;
  const cached = usageCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { windows: cached.windows.map(window => ({ ...window })) };
  }
  if (cached) usageCache.delete(key);
  const pending = usageInFlight.get(key);
  if (pending) {
    try {
      const value = await pending;
      return { windows: value.windows.map(window => ({ ...window })) };
    } catch (error) {
      return { windows: [], error: error instanceof Error ? error.message : "Claude usage read failed" };
    }
  }

  const request = readUsageUncached({ profileDir, env, command, spawnProcess, timeoutMs, fetchImpl, usageMode })
    .then(value => {
      const safeValue = { windows: value.windows.map(window => ({ ...window })) };
      usageCache.set(key, { expiresAt: Date.now() + usageCacheTtlMs, windows: safeValue.windows });
      return safeValue;
    })
    .finally(() => usageInFlight.delete(key));
  usageInFlight.set(key, request);
  try {
    const value = await request;
    return { windows: value.windows.map(window => ({ ...window })) };
  } catch (error) {
    return { windows: [], error: error instanceof Error ? error.message : "Claude usage read failed" };
  }
}
