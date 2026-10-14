import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeNativeTmuxGuard } from "../vendor/claude-bridge-magpie/src/native-tmux-guard.ts";

test("private tmux owner marker is synced and safely replaced for a later run", () => {
  const dir = mkdtempSync(join(tmpdir(), "magpie-native-owner-test-"));
  try {
    const marker = join(dir, "native-owner.tmux.json");
    writeNativeTmuxGuard(marker, "claude-bridge-deadbeef");
    const socketDigest = createHash("sha256").update(`${process.env.TMUX_TMPDIR ?? ""}\0${process.env.TMUX ?? ""}`).digest("hex");
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({version:2,session:"claude-bridge-deadbeef",socket_env_sha256:socketDigest});
    expect(statSync(marker).mode & 0o777).toBe(0o600);
    writeNativeTmuxGuard(marker, "claude-bridge-cafebabe");
    expect(JSON.parse(readFileSync(marker, "utf8")).session).toBe("claude-bridge-cafebabe");
    expect(statSync(marker).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(dir, {recursive:true,force:true});
  }
});

test("guard does not touch an existing marker when identity is malformed", () => {
  const dir = mkdtempSync(join(tmpdir(), "magpie-native-owner-test-"));
  try {
    const marker = join(dir, "native-owner.tmux.json");
    writeFileSync(marker, "old identity\n", {mode:0o600});
    expect(() => writeNativeTmuxGuard(marker, "not-a-tmux-session")).toThrow();
    expect(readFileSync(marker,"utf8")).toBe("old identity\n");
    expect(() => writeNativeTmuxGuard("relative-file", "claude-bridge-deadbeef")).toThrow();
  } finally {
    rmSync(dir, {recursive:true,force:true});
  }
});
