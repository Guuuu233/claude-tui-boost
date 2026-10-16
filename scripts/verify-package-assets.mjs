#!/usr/bin/env node
// Only permits packing binaries whose content hashes match the manifest.
// The build itself is explicit, reviewable, and handled by CI/release scripts.
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const list = readFileSync(join(root, 'SHA256SUMS'), 'utf8').trim().split('\n');
const expected = new Map();
for (const line of list) {
  const match = line.match(/^([0-9a-f]{64})  (bin\/[a-zA-Z0-9.-]+)$/);
  if (!match || expected.has(match[2])) throw new Error('Malformed or duplicate SHA256SUMS record');
  expected.set(match[2], match[1]);
}
const required = ['magpie-tui-bridge'];
for (const kind of ['magpie-tui-runtime', 'magpie-tui-mcp-helper']) {
  for (const os of ['darwin', 'linux']) {
    for (const arch of ['arm64', 'amd64']) required.push(`${kind}.${os}-${arch}`);
  }
}
if (expected.size !== required.length) throw new Error('Incomplete SHA256SUMS asset inventory');
for (const name of required) {
  const filename = 'bin/' + name;
  const stat = lstatSync(join(root, filename));
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid packaged binary: ${filename}`);
  const digest = createHash('sha256').update(readFileSync(join(root, filename))).digest('hex');
  if (expected.get(filename) !== digest) throw new Error(`Stale or tampered packaged binary: ${filename}`);
}
console.log(`Package asset integrity OK (${required.length} shipped executable files)`);
