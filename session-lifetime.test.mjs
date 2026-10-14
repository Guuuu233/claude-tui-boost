import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cli = readFileSync(new URL('./vendor/claude-bridge-magpie/src/cli.ts', import.meta.url), 'utf8');

test('long-running interactive Claude turns retain a configurable finite timeout', () => {
  const match = cli.match(/const MAX_SESSION_MS = envDurationMs\("CLAUDE_BRIDGE_MAX_SESSION_MS",\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d[\d_]*)\)/);
  assert.ok(match, 'missing configurable turn lifetime');
  const fallback = Number(match[1]) * Number(match[2]) * Number(match[3].replaceAll('_', ''));
  assert.ok(fallback >= 12 * 60 * 60_000, 'two-hour hard timeout would orphan long-running MCP calls');
  assert.ok(fallback <= 24 * 60 * 60_000, 'must retain a finite safety bound');
  assert.match(cli, /while \(!ctrl\.signal\.aborted && Date\.now\(\) - startedAt < MAX_SESSION_MS\)/);
  assert.match(cli, /function shutdown\(exitCode = 0\)/);
});
