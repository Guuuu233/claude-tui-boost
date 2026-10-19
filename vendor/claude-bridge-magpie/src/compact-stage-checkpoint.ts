/**
 * Durable, private progress for wrapper-only /compact across Desktop retries.
 *
 * The original desktop transcript is never modified. A checkpoint is keyed by
 * the canonical archival *contents* rather than per-request native session
 * identifiers, temporary cwd, or timestamps. Only validated completed
 * cumulative summaries are persisted; a failed stage never advances progress.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, statSync, unlinkSync, writeFileSync, fsyncSync,
} from "node:fs";
import { join } from "node:path";

export type StageCheckpoint = {
  version: 1;
  fingerprint: string;
  stages: number;
  completed: number;
  summary: string;
  updatedAt: number;
};

const MAX_CHECKPOINT_AGE_MS = 24 * 60 * 60_000;

export function archivalFingerprint(archive: string, model: string, limit: number, stageCount: number): string {
  const hash = createHash("sha256");
  hash.update("magpie-staged-compact-v1\0");
  hash.update(JSON.stringify([model, limit, stageCount]));
  // Do not hash generated UUIDs, tmp directories, session ids, or timestamps.
  // New compaction requests always re-seed those, even for identical history.
  for (const line of archive.trimEnd().split("\n")) {
    const row = JSON.parse(line);
    hash.update("\n");
    hash.update(JSON.stringify([row.type, row.message?.role, row.message?.content]));
  }
  return hash.digest("hex");
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.()) {
    throw new Error("staged checkpoint directory is not owned by this profile");
  }
  chmodSync(path, 0o700);
}

function lockIsOwnedByLiveProcess(path: string): boolean {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(data.pid) || data.pid <= 0) return true; // ambiguous: fail closed
    try { process.kill(data.pid, 0); return true; }
    catch (e: any) { return e?.code !== "ESRCH"; }
  } catch {
    return true; // unreadable lock: never silently override it
  }
}

/** Acquire an exclusive, per-history process lock. Caller must release in a
 * finally block after all native children have exited. */
export function openStageCheckpoint(
  dir: string, fingerprint: string, stages: number, maxSummaryBytes: number,
): {
  read(): StageCheckpoint | undefined;
  write(completed: number, summary: string): void;
  release(): void;
} {
  privateDirectory(dir);
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("invalid archival fingerprint");
  const path = join(dir, fingerprint + ".json");
  const lock = join(dir, fingerprint + ".lock");
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (err: any) {
    if (err?.code !== "EEXIST" || lockIsOwnedByLiveProcess(lock)) {
      throw new Error("an identical compaction is already running (or the lock requires operator review)");
    }
    // Dead owner; atomic exclusive recreation still prevents parallel resumes.
    unlinkSync(lock);
    fd = openSync(lock, "wx", 0o600);
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, time: Date.now() }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  let released = false;
  return {
    read() {
      if (!existsSync(path)) return undefined;
      const st = lstatSync(path);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.()
        || st.size > maxSummaryBytes + 2048) throw new Error("invalid checkpoint file");
      const state = JSON.parse(readFileSync(path, "utf8")) as StageCheckpoint;
      if (state.version !== 1 || state.fingerprint !== fingerprint || state.stages !== stages
        || !Number.isSafeInteger(state.completed) || state.completed < 0 || state.completed > stages
        || typeof state.summary !== "string" || Buffer.byteLength(state.summary) > maxSummaryBytes
        || !Number.isSafeInteger(state.updatedAt)) {
        throw new Error("checkpoint is incompatible with this archive");
      }
      if (Date.now() - state.updatedAt > MAX_CHECKPOINT_AGE_MS || state.updatedAt > Date.now() + 60_000) {
        return undefined; // stale checkpoint must never be used as live context
      }
      return state;
    },
    write(completed, summary) {
      if (!Number.isSafeInteger(completed) || completed < 1 || completed > stages
        || Buffer.byteLength(summary) > maxSummaryBytes) throw new Error("invalid completed stage state");
      const state: StageCheckpoint = {
        version: 1, fingerprint, stages, completed, summary, updatedAt: Date.now(),
      };
      const tmp = join(dir, "." + fingerprint + "." + randomUUID() + ".tmp");
      try {
        const fd = openSync(tmp, "wx", 0o600);
        try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); }
        finally { closeSync(fd); }
        renameSync(tmp, path);
      } finally {
        try { unlinkSync(tmp); } catch { /* renamed or never created */ }
      }
    },
    release() {
      if (released) return;
      released = true;
      unlinkSync(lock);
    },
  };
}
