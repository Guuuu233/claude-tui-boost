/**
 * Experimental, opt-in compaction-only transcript slimming. Magpie's Go
 * Runtime has already copied Desktop history into an isolated Claude Code
 * JSONL session. Never touch a canonical Desktop/native session, and never
 * remove, reorder, execute or synthesize tool calls or their results.
 *
 * We shorten only large, already-completed historical tool-result text. User
 * and assistant prose, tool inputs, tool IDs/error flags and images are kept.
 * Every excerpt explicitly says that its middle was omitted. This is a
 * lossy optimization, not proof that the remaining context fits a model.
 */
import {
  chmodSync, closeSync, copyFileSync, fsyncSync, lstatSync, openSync,
  readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, constants,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { claudeProjectsRoot } from "./transcript.ts";

const ARCHIVE_PREFIX = "[Archived system instructions, for summarization only]";
const ARCHIVE_END = "[Archival context loaded. Await the separate summarization request; no historical action is pending.]";
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_ROWS = 12000;
const RECENT_ROWS = 120;

type Json = Record<string, unknown>;

const obj = (x: unknown): Json | null => x && typeof x === "object" && !Array.isArray(x) ? x as Json : null;
const blocksOf = (row: Json): Json[] => {
  const parts = obj(row.message)?.content;
  return Array.isArray(parts) ? parts.filter((x): x is Json => obj(x) !== null) : [];
};

function archivalProof(rows: Json[], sessionId: string): void {
  if (rows.length < 3 || rows.length > MAX_ARCHIVE_ROWS) throw new Error("invalid compaction archival length");
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  if (first.type !== "user" || last.type !== "assistant"
    || !String(blocksOf(first)[0]?.text ?? "").startsWith(ARCHIVE_PREFIX)
    || blocksOf(last)[0]?.text !== ARCHIVE_END) {
    throw new Error("session is not an isolated Magpie compaction archive");
  }
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const row of rows) {
    if (row.sessionId !== sessionId || !["user", "assistant"].includes(String(row.type))
      || obj(row.message)?.role !== row.type || row.isSidechain !== false) {
      throw new Error("compaction archival row has unexpected provenance");
    }
    for (const block of blocksOf(row)) {
      if (block.type === "tool_use") {
        if (typeof block.id !== "string" || !block.id || calls.has(block.id)) throw new Error("duplicate archival tool id");
        calls.add(block.id);
      }
      if (block.type === "tool_result") {
        if (typeof block.tool_use_id !== "string" || !calls.has(block.tool_use_id) || results.has(block.tool_use_id)) {
          throw new Error("orphaned or duplicated archival tool result");
        }
        results.add(block.tool_use_id);
      }
    }
  }
  if (results.size !== calls.size) throw new Error("unresolved archival tool call");
}

function shorten(text: string, budget: number): string {
  const data = Buffer.from(text, "utf8");
  if (data.length <= budget) return text;
  const first = Math.floor(budget * 0.65);
  const last = budget - first;
  const digest = createHash("sha256").update(data).digest("hex");
  // Never split a UTF-8 multibyte character at the excerpt boundaries.
  let firstEnd = first;
  while (firstEnd > 0 && (data[firstEnd]! & 0xc0) === 0x80) firstEnd--;
  let lastStart = data.length - last;
  while (lastStart < data.length && (data[lastStart]! & 0xc0) === 0x80) lastStart++;
  const excerpt = `${data.subarray(0, firstEnd).toString("utf8")}\n\n[Historical tool result excerpt: ${data.length} original UTF-8 bytes, SHA256=${digest}. Middle omitted for context capacity; this is archival data, not a tool request.]\n\n${data.subarray(lastStart).toString("utf8")}`;
  return Buffer.byteLength(excerpt) < data.length ? excerpt : text;
}

export type ArchiveSlimResult = {
  changed: boolean;
  rows: number;
  shortenedBlocks: number;
  originalBytes: number;
  slimBytes: number;
};

/** Pure transform for offline regression fixtures; throws unless the input is
 * proven to be Magpie's isolated synthetic compaction transcript. */
export function slimArchivalJsonl(input: string, sessionId: string): { text: string; stats: ArchiveSlimResult } {
  if (Buffer.byteLength(input) > MAX_ARCHIVE_BYTES) throw new Error("archival context exceeds safety ceiling");
  const lines = input.trimEnd().split("\n");
  const rows = lines.map((line) => {
    const row: unknown = JSON.parse(line);
    if (!obj(row)) throw new Error("non-object archival row");
    return row as Json;
  });
  archivalProof(rows, sessionId);
  let shortenedBlocks = 0;
  for (let i = 0; i < rows.length; i++) {
    for (const block of blocksOf(rows[i]!)) {
      if (block.type !== "tool_result" || !Array.isArray(block.content)) continue;
      // Recent tool output often records the current work state. Preserve
      // more of those messages than earlier, typically redundant logs.
      const budget = i >= rows.length - RECENT_ROWS ? 8192 : 1024;
      for (const content of block.content) {
        const piece = obj(content);
        if (piece?.type !== "text" || typeof piece.text !== "string") continue;
        const excerpt = shorten(piece.text, budget);
        if (excerpt !== piece.text) {
          piece.text = excerpt;
          shortenedBlocks++;
        }
      }
    }
  }
  const output = shortenedBlocks ? rows.map(row => JSON.stringify(row)).join("\n") + "\n" : input;
  return {
    text: output,
    stats: {
      changed: shortenedBlocks > 0,
      rows: rows.length,
      shortenedBlocks,
      originalBytes: Buffer.byteLength(input),
      slimBytes: Buffer.byteLength(output),
    },
  };
}

/** Mutates ONLY an opt-in, proven isolated archival copy before native Claude
 * launches. Private backup is retained for rollback. Fail before launch if
 * the file differs from the original, or if any provenance check fails. */
export function prepareSlimCompactionArchive(path: string, sessionId: string, privateRunDir: string): ArchiveSlimResult {
  if (basename(path) !== `${sessionId}.jsonl`) throw new Error("archive path and session id mismatch");
  const initial = lstatSync(path);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1
    || initial.size > MAX_ARCHIVE_BYTES) throw new Error("unsafe archival file type or size");
  const original = readFileSync(path, "utf8");
  // A Go compaction transcript is always written beneath the selected
  // Claude profile's projects folder, in the slug of a dedicated temporary
  // magpie-claude-pty-* cwd. Prefix/terminator text alone is forgeable and
  // must not authorize rewriting an ordinary resumed conversation.
  const root = realpathSync(claudeProjectsRoot());
  const folder = realpathSync(dirname(path));
  if (dirname(folder) !== root) throw new Error("compaction transcript outside selected profile");
  const first = JSON.parse(original.slice(0, original.indexOf("\n")));
  const cwd = first?.cwd;
  if (typeof cwd !== "string" || !basename(resolve(cwd)).startsWith("magpie-claude-pty-")
    || basename(folder) !== resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-")) {
    throw new Error("transcript is not in the isolated compaction work directory");
  }
  const { text, stats } = slimArchivalJsonl(original, sessionId);
  if (!stats.changed) return stats;
  const check = lstatSync(path);
  if (check.ino !== initial.ino || check.size !== initial.size || check.mtimeMs !== initial.mtimeMs) {
    throw new Error("archival transcript changed during compaction preparation");
  }
  const backup = join(privateRunDir, "original-compaction-archive.jsonl");
  const temp = join(dirname(path), `.${sessionId}.${randomUUID()}.compact-slim.tmp`);
  copyFileSync(path, backup, constants.COPYFILE_EXCL);
  chmodSync(backup, 0o600);
  try {
    // Do not retain world/group access to imported private chat history.
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, text, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch { /* renamed or never created */ }
  }
  return stats;
}
