// scripts/managed-runtime-supervisor.mjs — account-owned runtime supervision.
// Managed hosts use --attach clients; one --shared-owner holds the Runtime
// and its claim until the last authenticated client disconnects.
//
//   node scripts/managed-runtime-supervisor.mjs \
//     --runtime <entry> [--runtime-arg <arg>]... \
//     --state-dir <dir> --ready-file <path> [--managed-key-stdin]
// With --managed-key-stdin, the first stdin line carries a 64-character key.
// Standalone mode can also let the Runtime generate its own key.
//
// Contract:
//   * Spawns `<runtime> --serve --port-file <state>/port --key-file <state>/key
//     --models-file <state>/models.json --state-dir <state> <runtime-args…>`
//     as an explicit argv — never a shell string — with a scrubbed
//     environment (no ANTHROPIC_* or credential overrides; explicit proxy settings are preserved).
//   * <state-dir> ownership is proven by a .managed-owner marker bound to the
//     managed key or, in keyless standalone mode, to the Runtime and path.
//     The marker protects checkpoints and establishes which directory can resume.
//   * With a managed key, starts the Runtime with --reuse-key against its
//     private 0600 key file. A conflicting key causes startup to fail.
//   * Once the handshake files (key, models.json, port) exist, writes
//     --ready-file and holds the child.
//   * An attach client's stdin EOF or SIGTERM releases only its connection.
//     The shared owner ends the Runtime after its last client disconnects.
//     Standalone supervision keeps the original stdin/SIGTERM lifetime.
//   * Runtime stdin stays open for the supervisor's lifetime. The Runtime
//     begins its normal shutdown on EOF if the supervisor exits.
//   * Runtime diagnostics stay on its own stderr; IPC reports lifecycle reasons.
import { spawn } from "node:child_process";
import { runtimeEnvironment } from "../src/runtime-environment.mjs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { chmodSync, closeSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, uptime } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

const sha256 = v => createHash("sha256").update(v).digest("hex");

function readLinuxBootId() {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { return ""; }
}

function isProcessDead(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); }
  catch (e) { return e?.code === "ESRCH"; }
  if (process.platform !== "linux") return false;
  try {
    // Linux retains exited PIDs until reaping. The explicit State field
    // identifies terminal states independently of the process name.
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    return /^State:[ \t]+[ZX](?:[ \t]|$)/m.test(status);
  } catch { return false; }
}

// A .managed-live claim left behind by an unclean reboot or SIGKILLed
// supervisor is safe to reclaim only when we can prove the claiming supervisor
// is gone (a different Linux boot_id, an ESRCH PID, or a Linux Z/X exit state).
// Running processes, EPERM and unknown process states keep their claim.
function isStaleSupervisorClaim(raw, bootId = readLinuxBootId()) {
  const parts = String(raw ?? "").trim().split(/\s+/);
  const pid = Number(parts[0]);
  const ts = Number(parts[1]);
  const claimBoot = parts[2] || "";
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isFinite(ts) || ts <= 0) return false;
  if (bootId && claimBoot && claimBoot !== bootId) return true;
  const bootTimeMs = Date.now() - uptime() * 1000;
  if (ts < bootTimeMs - 5000 && isProcessDead(pid)) return true;
  return isProcessDead(pid);
}

function readManagedKey(input) {
  return new Promise((resolveKey, reject) => {
    const frame = Buffer.alloc(65);
    let size = 0;
    const finish = (error, key) => {
      input.pause();
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("close", onEnd);
      input.off("error", onEnd);
      if (error) reject(error);
      else resolveKey(key);
    };
    const onEnd = () => finish(new Error("expected a 64-character lowercase hex key on stdin"));
    const onData = chunk => {
      if (size + chunk.length > frame.length) return onEnd();
      chunk.copy(frame, size);
      size += chunk.length;
      const end = chunk.indexOf(10);
      if (end < 0 && size < frame.length) return;
      const key = frame.subarray(0, 64).toString("latin1");
      if (size !== frame.length || end !== chunk.length - 1 || !/^[a-f0-9]{64}$/.test(key)) return onEnd();
      finish(null, key);
    };
    input.once("end", onEnd);
    input.once("close", onEnd);
    input.once("error", onEnd);
    input.on("data", onData);
    input.resume();
  });
}

function stageDrvFsExecutable(path) {
  if (!path || !path.startsWith("/mnt/")) return path;
  const name = basename(path);
  const binDir = join(nativeCacheRoot(), "bin");
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const destination = join(binDir, `${sha256(path).slice(0, 12)}-${name}`);
  if (name === "magpie-tui-bridge") {
    const pkgDir = dirname(dirname(path));
    const cliPath = join(pkgDir, "vendor", "claude-bridge-magpie", "src", "cli.ts").replaceAll("'", "'\\''");
    writePrivateAtomic(destination, `#!/bin/sh\nexec bun '${cliPath}' "$@"\n`, renameSync, 0o700);
  } else {
    const staging = mkdtempSync(join(binDir, "stage-"));
    const executable = join(staging, name);
    try {
      copyFileSync(path, executable);
      chmodSync(executable, 0o700);
      renameSync(executable, destination);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return destination;
}

function nativeCacheRoot() {
  const home = realpathSync(homedir());
  if (home.startsWith("/mnt/")) throw new Error("WSL Runtime requires a home directory on the Linux filesystem");
  return join(home, ".cache", "magpie-claude-tui");
}

const argv = process.argv.slice(2);
const attachMode = argv[0] === "--attach";
const sharedOwnerMode = argv[0] === "--shared-owner";
const SHARED_PROTOCOL = 1;
const ATTACH_WAIT_MS = 30000;
const IPC_LINE_BYTES = 16384;
const opt = name => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const runtime = opt("--runtime");
const stateDir = opt("--state-dir");
const readyFile = opt("--ready-file");
const runtimeArgs = argv.flatMap((v, i) => (v === "--runtime-arg" ? [argv[i + 1]] : []));

const die = message => {
  console.error(`managed-supervisor: ${message}`);
  process.exit(2);
};

let managedKey;
if (argv.includes("--managed-key-stdin")) {
  try { managedKey = await readManagedKey(process.stdin); }
  catch (error) { die(error.message); }
} else if (attachMode || sharedOwnerMode) {
  die("shared Runtime modes require --managed-key-stdin");
}

function checkNoSymlinkComponents(path, finalKind = "any") {
  const target = resolve(path);
  const m = target.match(/^[A-Za-z]:\\/);
  let current = m ? m[0] : sep;
  const rest = m ? target.slice(m[0].length) : target;
  for (const component of rest.split(sep).filter(Boolean)) {
    current = join(current, component);
    let st;
    try { st = lstatSync(current); } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw Object.assign(new Error(`cannot inspect ${current}: ${error.message}`), { code: "MANAGED_PATH_ERROR" });
    }
    if (st.isSymbolicLink()) throw Object.assign(new Error(`path contains symlink ${current}; refusing`), { code: "MANAGED_PATH_ERROR" });
    const final = current === target;
    if (!final && !st.isDirectory()) throw Object.assign(new Error(`path ancestor is not a directory: ${current}`), { code: "MANAGED_PATH_ERROR" });
    if (final && finalKind === "directory" && !st.isDirectory()) throw Object.assign(new Error(`path is not a directory: ${current}`), { code: "MANAGED_PATH_ERROR" });
    if (final && finalKind === "file" && !st.isFile()) throw Object.assign(new Error(`path is not a regular file: ${current}`), { code: "MANAGED_PATH_ERROR" });
  }
}

const assertNoSymlinkComponents = (path, finalKind = "any") => {
  try { checkNoSymlinkComponents(path, finalKind); }
  catch (error) { die(error.message); }
};

function writePrivateAtomic(path, content, publish = renameSync, mode = 0o600) {
  checkNoSymlinkComponents(path, "file");
  const temp = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  checkNoSymlinkComponents(temp, "file");
  const handle = openSync(temp, "wx", mode);
  try {
    try { writeFileSync(handle, content); }
    finally { closeSync(handle); }
    publish(temp, path);
  } finally {
    try { rmSync(temp, { force: true }); } catch {}
  }
}

function sharedConfig() {
  const value = name => {
    const index = runtimeArgs.indexOf(name);
    return index < 0 ? undefined : runtimeArgs[index + 1];
  };
  return {
    profile: value("--claude-config-dir") || process.env.CLAUDE_CONFIG_DIR || "",
    models: [...new Set((value("--models") || "claude-tui").split(",").filter(Boolean))],
  };
}

function privateIPCPath(path, kind) {
  checkNoSymlinkComponents(path, kind);
  const st = lstatSync(path);
  if ((st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid())) {
    throw new Error("shared Runtime discovery requires account-private paths");
  }
  if (kind === "socket" && !st.isSocket()) throw new Error("shared Runtime endpoint is not a local socket");
}

function directoryIdentity(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("shared Runtime state path must be absolute");
  checkNoSymlinkComponents(path, "directory");
  const st = statSync(path, { bigint: true });
  if (!st.isDirectory() || typeof st.dev !== "bigint" || typeof st.ino !== "bigint" || st.dev < 0n || st.ino <= 0n) {
    throw new Error("shared Runtime filesystem did not provide a usable directory identity");
  }
  return `directory-${st.dev.toString()}-${st.ino.toString()}`;
}

function nativeAccountRoot(directory = stateDir) {
  const identity = directoryIdentity(directory);
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid)) throw new Error("shared Runtime coordination requires Unix or WSL");
  const root = join(realpathSync("/tmp"), `magpie-tui-${uid}`);
  checkNoSymlinkComponents(root, "directory");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  privateIPCPath(root, "directory");
  // Directory metadata keys coordination/discovery lookup only.
  // Attachment retains the original state-path and managed-account checks.
  const account = join(root, "directories", identity);
  checkNoSymlinkComponents(account, "directory");
  mkdirSync(account, { recursive: true, mode: 0o700 });
  privateIPCPath(account, "directory");
  return account;
}

function sharedDiscoveryFile() {
  const account = resolve(stateDir).startsWith("/mnt/") ? nativeAccountRoot() : dirname(resolve(stateDir));
  return join(account, ".managed-runtime.json");
}

// Each startup announces a unique choosing slot before assigning its ticket.
// Atomic publication and (ticket, slot-name) ordering serialize claim recovery;
// only the slot creator removes it. Dead participants can be ignored safely.
async function acquireStartupTurn() {
  const directory = join(nativeAccountRoot(dirname(resolve(stateDir))), "startup");
  checkNoSymlinkComponents(directory, "directory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  privateIPCPath(directory, "directory");
  const own = mkdtempSync(join(directory, `slot-${process.pid}-`));
  chmodSync(own, 0o700);
  const name = basename(own);
  const boot = readLinuxBootId();
  let released = false;
  const releaseTurn = () => {
    if (released) return;
    released = true;
    process.removeListener("exit", releaseTurn);
    try { rmSync(own, { recursive: true, force: true }); } catch {}
  };
  process.once("exit", releaseTurn);
  const participants = () => {
    const found = [];
    for (const entry of readdirSync(directory)) {
      const match = /^slot-([1-9][0-9]*)-/.exec(entry);
      if (!match || entry === name) continue;
      const pid = Number(match[1]);
      if (isProcessDead(pid)) continue;
      const slot = join(directory, entry);
      let record;
      try {
        privateIPCPath(slot, "directory");
        const file = join(slot, "ticket.json");
        privateIPCPath(file, "file");
        if (statSync(file).size > 4096) throw new Error("startup ticket is oversized");
        record = JSON.parse(readFileSync(file, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") throw new Error("account startup coordination contains an unreadable ticket");
        try { privateIPCPath(slot, "directory"); }
        catch (slotError) {
          if (slotError?.code === "ENOENT") continue;
          throw new Error("account startup coordination could not prove a participant's exit");
        }
        found.push({ name: entry, choosing: true, ticket: 0 });
        continue;
      }
      if (record?.pid !== pid || typeof record.boot !== "string" || typeof record.choosing !== "boolean" ||
          !Number.isSafeInteger(record.ticket) || record.ticket < 0 || (!record.choosing && record.ticket === 0)) {
        throw new Error("account startup coordination contains an invalid ticket");
      }
      if (boot && record.boot && record.boot !== boot) continue;
      found.push({ name: entry, choosing: record.choosing, ticket: record.ticket });
    }
    return found;
  };
  const publish = (choosing, ticket) => writePrivateAtomic(join(own, "ticket.json"), JSON.stringify({ pid: process.pid, boot, choosing, ticket }) + "\n");
  try {
    publish(true, 0);
    const maximum = participants().reduce((highest, other) => Math.max(highest, other.ticket), 0);
    const ticket = maximum + 1;
    if (!Number.isSafeInteger(ticket)) throw new Error("account startup ticket range is exhausted");
    publish(false, ticket);
    const deadline = Date.now() + ATTACH_WAIT_MS;
    while (participants().some(other => other.choosing || other.ticket < ticket || (other.ticket === ticket && other.name < name))) {
      if (Date.now() >= deadline) throw new Error("account Runtime startup coordination stayed busy for 30 seconds; preserve its active work");
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    return releaseTurn;
  } catch (error) { releaseTurn(); throw error; }
}

function readSharedOwner(claim) {
  const discovery = sharedDiscoveryFile();
  privateIPCPath(dirname(discovery), "directory");
  let raw;
  try {
    privateIPCPath(discovery, "file");
    raw = readFileSync(discovery, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (Buffer.byteLength(raw) > IPC_LINE_BYTES) throw new Error("shared Runtime discovery is oversized");
  let found;
  try { found = JSON.parse(raw); }
  catch { throw new Error("shared Runtime discovery is malformed"); }
  if (found?.claim !== claim) return null; // a winning owner may still be publishing
  if (found.version !== SHARED_PROTOCOL || found.ownerPid !== Number(claim.split(/\s+/)[0]) ||
      found.stateDir !== resolve(stateDir) || typeof found.socketPath !== "string" ||
      !isAbsolute(found.socketPath) || Buffer.byteLength(found.socketPath) > 100) {
    throw new Error("shared Runtime discovery does not match the account's live owner");
  }
  try {
    privateIPCPath(dirname(found.socketPath), "directory");
    privateIPCPath(found.socketPath, "socket");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return found;
}

function refuseLiveClaim(prior) {
  // A concurrent shared owner won the existing claim. Its waiting clients
  // attach to that winner; this process has started no Runtime of its own.
  if (sharedOwnerMode && prior.trim().split(/\s+/).at(-1) === "shared-v1") process.exit(0);
  die(`state-dir ${stateDir} already has a live supervisor claim (${prior || "unreadable"}); refusing to double-start`);
}

async function runAttachClient() {
  let connection;
  const leave = () => {
    connection?.destroy();
    process.exit(0);
  };
  if (!process.stdin.readable) return;
  process.stdin.resume();
  process.stdin.once("end", leave);
  process.stdin.once("close", leave);
  process.stdin.once("error", leave);
  process.on("SIGTERM", leave);
  process.on("SIGINT", leave);
  process.once("exit", () => {
    try {
      checkNoSymlinkComponents(readyFile, "file");
      if (JSON.parse(readFileSync(readyFile, "utf8")).supervisorPid === process.pid) rmSync(readyFile);
    } catch {}
  });
  const deadline = Date.now() + ATTACH_WAIT_MS;
  let launched = false;
  let launchFailed = false;
  let ownerExit = null;
  while (Date.now() < deadline) {
    let claim = "";
    try {
      checkNoSymlinkComponents(liveFile, "file");
      claim = readFileSync(liveFile, "utf8").trim();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (!claim || isStaleSupervisorClaim(claim)) {
      if (!launched) {
        launched = true;
        const owner = spawn(process.execPath, [fileURLToPath(import.meta.url), "--shared-owner", ...argv.slice(1)], {
          env: process.env, detached: true, stdio: ["pipe", "ignore", "ignore"],
        });
        owner.once("error", () => { launchFailed = true; });
        owner.once("exit", code => { ownerExit = code ?? 1; });
        owner.stdin.on("error", () => { launchFailed = true; });
        owner.stdin.end(`${managedKey}\n`);
        owner.unref();
      } else if (launchFailed || (ownerExit !== null && ownerExit !== 0)) {
        throw new Error(`canonical Runtime owner could not establish its private attachment endpoint (code ${ownerExit ?? "spawn"})`);
      }
    } else {
      if (claim.split(/\s+/).at(-1) !== "shared-v1") {
        throw new Error("account state already has a live supervisor claim without shared attachment support; keep its active work and update at an idle boundary");
      }
      const found = readSharedOwner(claim);
      if (found) {
        try {
          await holdSharedConnection(found, deadline - Date.now(), socket => { connection = socket; });
          return;
        } catch (error) {
          if (error?.code !== "OWNER_ENDPOINT_CLOSED") throw error;
          let current = "";
          try { current = readFileSync(liveFile, "utf8").trim(); }
          catch (readError) { if (readError?.code !== "ENOENT") throw readError; }
          // Only the observed startup/shutdown window may be waited out.
          // A live owner with an unchanged endpoint remains protected.
          if (current === claim && readSharedOwner(current)) throw error;
        }
      }
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 60));
  }
  throw new Error("shared Runtime attachment did not become ready within 30 seconds");
}

function holdSharedConnection(found, wait, setConnection) {
  return new Promise((_, reject) => {
    const socket = createConnection(found.socketPath);
    setConnection(socket);
    let text = "";
    let ready = false;
    let settled = false;
    const fail = (message, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(Object.assign(new Error(message), code ? { code } : {}));
    };
    const timer = setTimeout(() => fail("shared Runtime attachment handshake timed out"), Math.max(1, wait));
    socket.once("connect", () => {
      socket.write(JSON.stringify({
        type: "attach", version: SHARED_PROTOCOL, claim: found.claim,
        proof: managedKey, config: sharedConfig(),
      }) + "\n");
    });
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      if (settled) return;
      text += chunk;
      let newline;
      while ((newline = text.indexOf("\n")) >= 0) {
        const line = text.slice(0, newline);
        text = text.slice(newline + 1);
        if (Buffer.byteLength(line) > IPC_LINE_BYTES) return fail("shared Runtime attachment reply is oversized");
        let reply;
        try { reply = JSON.parse(line); }
        catch { return fail("shared Runtime attachment reply is malformed"); }
        if (reply?.type === "error") return fail(reply.message || "shared Runtime attachment was refused");
        if (ready || reply?.type !== "ready" || reply.ownerPid !== found.ownerPid || reply.claim !== found.claim ||
            reply.stateDir !== resolve(stateDir) || !Number.isSafeInteger(reply.pid) || reply.pid < 1 ||
            !Number.isInteger(reply.port) || reply.port < 1 || reply.port > 65535) {
          return fail("shared Runtime endpoint does not match the authenticated owner");
        }
        try {
          checkNoSymlinkComponents(liveFile, "file");
          if (readFileSync(liveFile, "utf8").trim() !== found.claim) throw new Error("owner changed");
          writePrivateAtomic(readyFile, JSON.stringify({
            supervisorPid: process.pid, ownerSupervisorPid: found.ownerPid, ownerClaim: found.claim,
            pid: reply.pid, port: reply.port, stateDir: reply.stateDir,
          }) + "\n");
        } catch { return fail("shared Runtime owner or private readiness path changed during attachment"); }
        ready = true;
        clearTimeout(timer);
      }
      if (Buffer.byteLength(text) > IPC_LINE_BYTES) return fail("shared Runtime attachment reply is oversized");
    });
    socket.once("error", error => fail("shared Runtime owner is not accepting attachments; preserve active work and retry at an idle boundary",
      !ready && ["ENOENT", "ECONNREFUSED"].includes(error?.code) ? "OWNER_ENDPOINT_CLOSED" : undefined));
    socket.once("close", () => fail(ready ? "shared Runtime owner disconnected" : "shared Runtime owner closed the attachment handshake",
      ready ? undefined : "OWNER_ENDPOINT_CLOSED"));
  });
}

async function openSharedOwnerControl(onEmpty, onFailure) {
  const discovery = sharedDiscoveryFile();
  privateIPCPath(dirname(discovery), "directory");
  const socketDir = mkdtempSync(join(realpathSync("/tmp"), "mgtui-ipc-"));
  chmodSync(socketDir, 0o700);
  const socketPath = join(socketDir, "owner.sock");
  const authenticated = new Set();
  const sockets = new Set();
  const expectedProof = Buffer.from(managedKey || "");
  const expectedConfig = sharedConfig();
  let ready = null;
  let closing = false;
  let firstClient = false;
  let published = "";
  let bootstrap;
  const sendReady = socket => { if (ready && !socket.destroyed) socket.write(JSON.stringify(ready) + "\n"); };
  const server = createServer(socket => {
    if (closing) { socket.destroy(); return; }
    sockets.add(socket);
    let text = "";
    let handled = false;
    const timeout = setTimeout(() => socket.destroy(), 5000);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.once("close", () => {
      clearTimeout(timeout);
      sockets.delete(socket);
      if (authenticated.delete(socket) && authenticated.size === 0 && firstClient && !closing) onEmpty();
    });
    const refuse = message => {
      handled = true;
      clearTimeout(timeout);
      socket.end(JSON.stringify({ type: "error", message }) + "\n", () => socket.destroy());
    };
    socket.on("data", chunk => {
      if (handled) { socket.destroy(); return; }
      text += chunk;
      if (Buffer.byteLength(text) > IPC_LINE_BYTES) { socket.destroy(); return; }
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      let request;
      try { request = JSON.parse(text.slice(0, newline)); }
      catch { refuse("shared Runtime attachment request is malformed"); return; }
      text = "";
      const proof = Buffer.from(typeof request?.proof === "string" ? request.proof : "");
      if (closing || request?.type !== "attach" || request.version !== SHARED_PROTOCOL || request.claim !== claimId ||
          proof.length !== expectedProof.length || expectedProof.length === 0 || !timingSafeEqual(proof, expectedProof)) {
        refuse("shared Runtime attachment did not prove the owned account");
        return;
      }
      const config = request.config;
      if (config?.profile !== expectedConfig.profile || !Array.isArray(config.models) || config.models.length === 0 ||
          !config.models.every(model => expectedConfig.models.includes(model))) {
        refuse("shared Runtime profile or models differ from this account's active launch; finish active work before changing its configuration");
        return;
      }
      handled = true;
      clearTimeout(timeout);
      clearTimeout(bootstrap);
      firstClient = true;
      authenticated.add(socket);
      sendReady(socket);
    });
  });
  const dispose = () => {
    closing = true;
    clearTimeout(bootstrap);
    try { server.close(); } catch {}
    for (const socket of sockets) socket.destroy();
    try {
      checkNoSymlinkComponents(discovery, "file");
      if (published && readFileSync(discovery, "utf8") === published) rmSync(discovery);
    } catch {}
    try { rmSync(socketDir, { recursive: true, force: true }); } catch {}
  };
  process.once("exit", dispose);
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(socketPath, () => { server.removeListener("error", rejectListen); resolveListen(); });
    });
    chmodSync(socketPath, 0o600);
    server.on("error", onFailure);
    published = JSON.stringify({ version: SHARED_PROTOCOL, ownerPid: process.pid, claim: claimId, socketPath, stateDir: resolve(stateDir) }) + "\n";
    writePrivateAtomic(discovery, published);
    bootstrap = setTimeout(() => { if (!firstClient) onEmpty(); }, ATTACH_WAIT_MS);
  } catch (error) { dispose(); throw error; }
  return {
    ready(descriptor) {
      if (closing) return;
      ready = { type: "ready", ownerPid: process.pid, claim: claimId, ...descriptor };
      for (const socket of authenticated) sendReady(socket);
    },
    report(message) {
      if (authenticated.size === 0) return Promise.resolve();
      return new Promise(resolveReport => {
        let pending = authenticated.size;
        const timer = setTimeout(resolveReport, 200);
        const delivered = () => {
          if (--pending === 0) { clearTimeout(timer); resolveReport(); }
        };
        // Fixed lifecycle reasons carry no request bodies or account proof.
        const line = JSON.stringify({ type: "error", message }) + "\n";
        for (const socket of authenticated) {
          if (socket.destroyed) { delivered(); continue; }
          try { socket.end(line, delivered); }
          catch { delivered(); }
        }
      });
    },
    close() {
      closing = true;
      clearTimeout(bootstrap);
      try {
        checkNoSymlinkComponents(discovery, "file");
        if (published && readFileSync(discovery, "utf8") === published) rmSync(discovery);
      } catch {}
      try { server.close(); } catch {}
      for (const socket of sockets) if (!authenticated.has(socket)) socket.destroy();
    },
  };
}

if (!runtime || !isAbsolute(runtime)) die("--runtime must be an absolute entry path");
if (!stateDir || !isAbsolute(stateDir)) die("--state-dir must be absolute");
if (!readyFile || !isAbsolute(readyFile)) die("--ready-file must be absolute");
const ownedFlags = new Set(["--serve", "--port-file", "--key-file", "--models-file", "--state-dir", "--reuse-key", "--exit-on-stdin-eof"]);
if (runtimeArgs.some(arg => ownedFlags.has(arg?.split("=", 1)[0]))) {
  die("runtime args must preserve the owned handshake and lifetime flags");
}
assertNoSymlinkComponents(dirname(resolve(readyFile)), "directory");
assertNoSymlinkComponents(readyFile, "file");
assertNoSymlinkComponents(stateDir, "directory");

// The state dir is ours alone. A previously owned dir may hold checkpoints
// and must resume; a foreign or conflicting dir is refused — never cleared,
// claimed or deleted.
const parent = dirname(resolve(stateDir));
if (!existsSync(parent)) die(`state-dir parent missing: ${parent}`);
const inside = (p, base) => {
  const r = resolve(base), t = resolve(p);
  return t === r || t.startsWith(r + sep);
};
// A state dir must stay under the ready-file's own directory (the
// per-account root the caller allocated); outside paths are not owned state.
if (!inside(stateDir, dirname(resolve(readyFile)))) die("state-dir escapes the supervisor root; refusing");
const liveFile = join(stateDir, ".managed-live");
if (attachMode) {
  try { await runAttachClient(); }
  catch (error) { die(error.message); }
  process.exit(0);
}

let releaseStartup;
try { releaseStartup = await acquireStartupTurn(); }
catch (error) { die(error.message); }

const ownerHash = sha256("managed-owner/v1\0" + (managedKey ?? (runtime + "\0" + resolve(stateDir))));
const marker = join(stateDir, ".managed-owner");
for (const file of [marker, liveFile, join(stateDir, "key"), join(stateDir, "port"), join(stateDir, "models.json")]) {
  assertNoSymlinkComponents(file, "file");
}
// Realpath the ancestors too — a symlinked parent would put the real dir
// outside the ready-file root even though lstat on the leaf looks clean.
try {
  const realParent = realpathSync(parent);
  const realReadyParent = realpathSync(dirname(resolve(readyFile)));
  if (realParent !== realReadyParent && !realParent.startsWith(realReadyParent + sep)) {
    die(`state-dir realpath ${realParent} escapes the supervisor root ${realReadyParent}; refusing`);
  }
} catch (error) { if (error?.code !== "ENOENT") die(`ancestor realpath: ${error.message}`); }
try {
  const st = lstatSync(stateDir);
  if (st.isSymbolicLink()) die(`state-dir ${stateDir} is a symlink; refusing`);
  if (!st.isDirectory()) die(`state-dir ${stateDir} exists and is not a directory; refusing`);
  assertNoSymlinkComponents(marker, "file");
  let prior;
  try { prior = readFileSync(marker, "utf8").trim(); } catch {}
  if (prior !== ownerHash) die(`state-dir ${stateDir} holds foreign or conflicting state; refusing (checkpoint/dirty state is never cleared)`);
} catch (error) {
  if (error?.code !== "ENOENT") die(`state-dir: ${error.message}`);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(stateDir, "directory");
  try { writePrivateAtomic(marker, ownerHash + "\n"); }
  catch (error) { die(`owner marker could not be written safely: ${error.message}`); }
}
try { chmodSync(stateDir, 0o700); }
catch (error) { die(`owned state-dir permissions could not be secured: ${error.message}`); }
// Startup coordination serializes stale claim reclamation. Publish the full
// claim in one exclusive link operation so every observer sees a complete record.
const bootId = readLinuxBootId();
const claimId = `${process.pid} ${Date.now()}${bootId ? " " + bootId : ""}${sharedOwnerMode ? " shared-v1" : ""}`;
const publishClaim = () => writePrivateAtomic(liveFile, claimId + "\n", linkSync);
try { publishClaim(); }
catch (error) {
  if (error?.code !== "EEXIST") die(`state-dir claim: ${error.message}`);
  let prior = "";
  try { prior = readFileSync(liveFile, "utf8").trim(); } catch {}
  if (!prior || !isStaleSupervisorClaim(prior, bootId)) refuseLiveClaim(prior);
  try {
    assertNoSymlinkComponents(liveFile, "file");
    rmSync(liveFile, { force: true });
    publishClaim();
  } catch (retryError) {
    if (retryError?.code === "EEXIST") refuseLiveClaim(readFileSync(liveFile, "utf8").trim());
    die(`state-dir claim: ${retryError.message}`);
  }
}
const release = () => { try { if (readFileSync(liveFile, "utf8").trim() === claimId) rmSync(liveFile, { force: true }); } catch {} };
process.once("exit", release);
releaseStartup();

const onDrvFs = stateDir.startsWith("/mnt/");
const nativeAccountDir = onDrvFs ? join(nativeCacheRoot(), "drvfs", sha256(stateDir).slice(0, 16)) : null;
const runtimeStateDir = nativeAccountDir ? join(nativeAccountDir, "state") : stateDir;
const keyFile = join(nativeAccountDir ?? stateDir, "key");
const portFile = join(stateDir, "port");
const modelsFile = join(stateDir, "models.json");
for (const file of [keyFile, portFile, modelsFile, readyFile]) assertNoSymlinkComponents(file, "file");

// Keep the Runtime key and private state in the native filesystem on WSL.
try {
  if (nativeAccountDir) mkdirSync(runtimeStateDir, { recursive: true, mode: 0o700 });
  try {
    lstatSync(keyFile);
    if (!managedKey) die(`key file ${keyFile} already exists; standalone mode requires a fresh key path`);
    const prior = readFileSync(keyFile, "utf8");
    if (prior.trim() !== managedKey) die(`key file ${keyFile} holds different bytes; refusing conflicting owned state`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (managedKey) writePrivateAtomic(keyFile, managedKey);
} catch (error) { die(`key file could not be written safely: ${error.message}`); }

// Stale handshake descriptors from a dead previous run are ours to remove
// (the runtime rewrites them atomically); checkpoints are never touched.
for (const f of [portFile, modelsFile]) {
  assertNoSymlinkComponents(f, "file");
  try { rmSync(f, { force: true }); } catch {}
}

// Scrubbed child env: the runtime authenticates through its own key file;
// inherited API credentials are removed; configured proxy/certificate settings are preserved.
const env = runtimeEnvironment({}, process.env);
for (const keep of ["PATH", "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "SYSTEMROOT", "USERPROFILE", "CLAUDE_CONFIG_DIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]) {
  if (process.env[keep] !== undefined) env[keep] = process.env[keep];
}


const effectiveRuntimeArgs = [...runtimeArgs];
for (let i = 0; i < effectiveRuntimeArgs.length - 1; i++) {
  if (effectiveRuntimeArgs[i] === "--helper" || effectiveRuntimeArgs[i] === "--bridge") {
    effectiveRuntimeArgs[i + 1] = stageDrvFsExecutable(effectiveRuntimeArgs[i + 1]);
  }
}

const child = spawn(stageDrvFsExecutable(runtime), [
  "--serve",
  "--port-file", portFile,
  "--key-file", keyFile,
  "--models-file", modelsFile,
  "--state-dir", runtimeStateDir,
  ...(managedKey ? ["--reuse-key"] : []),
  "--exit-on-stdin-eof",
  ...effectiveRuntimeArgs,
], {
  env,
  stdio: ["pipe", "inherit", "inherit"],
});
child.stdin.on("error", () => {});

let stopping = false;
let sharedControl = null;
let childExit = null;
child.once("error", error => {
  if (!child.pid) childExit = { code: 1, signal: null };
  console.error(`managed-supervisor: runtime process error: ${error.message}`);
});
child.once("exit", (code, signal) => { childExit = { code, signal }; });

const GRACE_MS = 15000;
const killTimer = () => setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, GRACE_MS);

function shutdown(exitCode, reason) {
  if (stopping) return;
  stopping = true;
  sharedControl?.close();
  const notification = reason && sharedControl ? sharedControl.report(reason) : Promise.resolve();
  try { child.kill("SIGTERM"); } catch {}
  const killer = killTimer();
  const done = new Promise(res => {
    if (childExit) return res();
    child.once("exit", res);
  });
  done.then(async () => {
    clearTimeout(killer);
    await notification;
    release();
    process.exit(exitCode);
  });
}

// Each managed host owns only an attach client. The canonical owner lives
// while any authenticated client remains, independently of the first host.
if (sharedOwnerMode) {
  try {
    sharedControl = await openSharedOwnerControl(() => shutdown(0), () => shutdown(1, "canonical Runtime owner attachment endpoint failed"));
  } catch (error) {
    console.error(`managed-supervisor: private attachment endpoint could not be opened: ${error.message}`);
    shutdown(1);
  }
} else if (process.stdin.readable) {
  process.stdin.resume();
  process.stdin.once("end", () => shutdown(0));
  process.stdin.once("close", () => shutdown(0));
  process.stdin.once("error", () => shutdown(0));
} else {
  shutdown(0);
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

// Handshake: poll for the committed descriptor set (key+models+port written
// in that order by the runtime), bounded, then mark ready.
const deadline = Date.now() + 30000;
const poll = setInterval(() => {
  if (stopping) { clearInterval(poll); return; }
  if (childExit) {
    clearInterval(poll);
    stopping = true;
    const status = childExit.signal ?? `code ${childExit.code}`;
    console.error(`managed-supervisor: runtime exited before ready (${status})`);
    try { rmSync(readyFile, { force: true }); } catch {}
    sharedControl?.close();
    const notification = sharedControl?.report(`Runtime exited before ready (${status})`) ?? Promise.resolve();
    notification.then(() => { release(); process.exit(1); });
    return;
  }
  try {
    if (existsSync(keyFile) && existsSync(modelsFile) && existsSync(portFile)) {
      try {
        for (const file of [keyFile, modelsFile, portFile, readyFile]) checkNoSymlinkComponents(file, "file");
      } catch (error) {
        if (error?.code === "MANAGED_PATH_ERROR") {
          clearInterval(poll);
          console.error(`managed-supervisor: unsafe runtime handshake path: ${error.message}`);
          shutdown(1, "Runtime readiness path failed its ownership checks");
          return;
        }
        throw error;
      }
      const port = readFileSync(portFile, "utf8").trim();
      const portNumber = Number(port);
      if (!/^\d+$/.test(port) || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) throw new Error("invalid port");
      clearInterval(poll);
      if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
        console.error("managed-supervisor: runtime child did not expose an owned pid");
        shutdown(1, "Runtime child did not expose an owned PID");
        return;
      }
      try {
        const descriptor = { pid: child.pid, port: portNumber, stateDir: resolve(stateDir) };
        if (sharedControl) sharedControl.ready(descriptor);
        else writePrivateAtomic(readyFile, JSON.stringify({ supervisorPid: process.pid, ...descriptor }) + "\n");
      }
      catch (error) {
        clearInterval(poll);
        console.error(`managed-supervisor: ready descriptor could not be written safely: ${error.message}`);
        shutdown(1, "Runtime readiness could not be published safely");
        return;
      }
      child.once("exit", (code, signal) => {
        if (stopping) return; // shutdown owns its requested exit code and cleanup
        stopping = true;
        sharedControl?.close();
        const status = signal ?? `code ${code}`;
        const notification = sharedControl?.report(`Runtime process exited (${status})`) ?? Promise.resolve();
        notification.then(() => { release(); process.exit(code ?? 1); });
      });
      return;
    }
  } catch {}
  if (Date.now() > deadline) {
    clearInterval(poll);
    console.error("managed-supervisor: runtime handshake timed out");
    shutdown(1, "Runtime handshake timed out");
  }
}, 60);
