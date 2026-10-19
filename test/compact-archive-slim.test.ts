import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, lstatSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { slimArchivalJsonl, prepareSlimCompactionArchive } from "../vendor/claude-bridge-magpie/src/compact-archive-slim.ts";

const id = "12345678-1234-4234-a234-123456789abc";
const start = "[Archived system instructions, for summarization only]\nSynthetic archival system context";
const end = "[Archival context loaded. Await the separate summarization request; no historical action is pending.]";

function row(role: "user" | "assistant", content: unknown[]) {
  return { type: role, sessionId: id, isSidechain: false, message: { role, content } };
}
function archive(text = "A".repeat(22000), cwd = "/tmp/magpie-claude-pty-synthetic") {
  return [
    row("user", [{ type: "text", text: start }]),
    row("user", [{ type: "text", text: "Keep cobalt as the selected color, and never touch production." }]),
    row("assistant", [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "echo do-not-replay" } }]),
    row("user", [{ type: "tool_result", tool_use_id: "tool-1", is_error: true,
      content: [{ type: "text", text }, { type: "image", source: { type: "base64", media_type: "image/png", data: "SYNTHETIC" } }] }]),
    row("assistant", [{ type: "text", text: "Final decision: no production changes." }]),
    row("assistant", [{ type: "text", text: end }]),
  ].map(x => JSON.stringify({ ...x, cwd })).join("\n") + "\n";
}

test("only long archival tool result text is reduced; all decisions and paired tools survive", () => {
  const original = archive();
  const { text, stats } = slimArchivalJsonl(original, id);
  expect(stats.changed).toBe(true);
  expect(stats.shortenedBlocks).toBe(1);
  expect(stats.slimBytes).toBeLessThan(stats.originalBytes / 2);
  const before = original.trim().split("\n").map(JSON.parse);
  const after = text.trim().split("\n").map(JSON.parse);
  expect(after).toHaveLength(before.length);
  expect(after[1]).toEqual(before[1]);
  expect(after[2]).toEqual(before[2]);
  expect(after[3].message.content[0].tool_use_id).toBe("tool-1");
  expect(after[3].message.content[0].is_error).toBe(true);
  expect(after[3].message.content[0].content[1]).toEqual(before[3].message.content[0].content[1]);
  expect(after[3].message.content[0].content[0].text).toContain("Middle omitted");
  expect(after[4]).toEqual(before[4]);
});

test("rejects normal resumed sessions and unmatched archival tool calls", () => {
  const rows = archive().trim().split("\n").map(JSON.parse);
  rows[0].message.content[0].text = "regular old system text";
  const ordinary = rows.map(JSON.stringify).join("\n") + "\n";
  expect(() => slimArchivalJsonl(ordinary, id)).toThrow(/not an isolated/);
  rows[0].message.content[0].text = start;
  rows[3].message.content[0].tool_use_id = "other";
  const orphaned = rows.map(JSON.stringify).join("\n") + "\n";
  expect(() => slimArchivalJsonl(orphaned, id)).toThrow(/orphaned/);
  expect(() => slimArchivalJsonl(archive(), "wrong-session")).toThrow(/provenance/);
});

test("preserves private original and atomically rewrites only a dedicated archival copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "compact-archive-slim-"));
  const run = join(dir, "run");
  mkdirSync(run, { mode: 0o700 });
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  const cwd = join(dir, "magpie-claude-pty-fixture");
  const project = join(dir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  const path = join(project, `${id}.jsonl`);
  const original = archive(undefined, cwd);
  writeFileSync(path, original, { mode: 0o600 });
  try {
    const result = prepareSlimCompactionArchive(path, id, run);
    expect(result.changed).toBe(true);
    expect(readFileSync(join(run, "original-compaction-archive.jsonl"), "utf8")).toBe(original);
    expect(readFileSync(path, "utf8")).not.toBe(original);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  } finally {
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
  }
});

test("refuses symlinked archive without touching its target", () => {
  const dir = mkdtempSync(join(tmpdir(), "compact-archive-symlink-"));
  const target = join(dir, "source.jsonl");
  const link = join(dir, `${id}.jsonl`);
  writeFileSync(target, archive(), { mode: 0o600 });
  symlinkSync(target, link);
  expect(() => prepareSlimCompactionArchive(link, id, dir)).toThrow(/unsafe archival/);
  expect(readFileSync(target, "utf8")).toBe(archive());
});

test("preserves valid Chinese UTF-8 boundaries when historical output is excerpted", () => {
  const { text } = slimArchivalJsonl(archive("汉字处理正常。".repeat(5000)), id);
  const rows = text.trim().split("\n").map(JSON.parse);
  const excerpt = rows[3].message.content[0].content[0].text;
  expect(excerpt).toContain("Middle omitted");
  expect(excerpt).not.toContain("\uFFFD");
});
