#!/usr/bin/env node
// The inventory records packaged file structure and target platforms.
// Content identity and source reproducibility are separate verification scopes.
import { closeSync, lstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'package-assets.json');
const goVersion = '1.27.2';
const required = [{ path: 'bin/magpie-tui-bridge', kind: 'bridge', platform: 'any', arch: 'any' }];
for (const [kind, name] of [['runtime', 'magpie-tui-runtime'], ['helper', 'magpie-tui-mcp-helper']]) {
  for (const platform of ['darwin', 'linux']) {
    for (const arch of ['amd64', 'arm64']) {
      required.push({ path: `bin/${name}.${platform}-${arch}`, kind, platform, arch });
    }
  }
}

function regularFile(path, executable = false) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${path}`);
  if (!Number.isSafeInteger(stat.size) || stat.size <= 0) throw new Error(`Expected a nonempty file: ${path}`);
  if (executable && process.platform !== 'win32' && (stat.mode & 0o111) === 0) {
    throw new Error(`Expected executable permissions: ${path}`);
  }
  return stat;
}

function inspectAsset(asset) {
  const filename = join(root, asset.path);
  const stat = regularFile(filename, true);
  if (asset.kind === 'bridge') {
    const script = readFileSync(filename, 'utf8');
    if (!/^#!\/bin\/sh\r?\n/.test(script) || !/\bexec\s+bun\b/.test(script) ||
        !script.includes('vendor/claude-bridge-magpie/src/cli.ts')) {
      throw new Error(`Expected the packaged Bun wrapper entry: ${asset.path}`);
    }
    regularFile(join(root, 'vendor/claude-bridge-magpie/src/cli.ts'));
  } else {
    const header = Buffer.alloc(64);
    const fd = openSync(filename, 'r');
    let length;
    try { length = readSync(fd, header, 0, header.length, 0); }
    finally { closeSync(fd); }
    if (asset.platform === 'linux') {
      const machine = { amd64: 62, arm64: 183 }[asset.arch];
      if (length < 64 || header.readUInt32BE(0) !== 0x7f454c46 || header[4] !== 2 ||
          header[5] !== 1 || header[6] !== 1 || header.readUInt16LE(18) !== machine ||
          ![2, 3].includes(header.readUInt16LE(16))) {
        throw new Error(`Expected a 64-bit little-endian ELF executable for ${asset.arch}: ${asset.path}`);
      }
    } else {
      const cpu = { amd64: 0x01000007, arm64: 0x0100000c }[asset.arch];
      if (length < 32 || header.readUInt32LE(0) !== 0xfeedfacf ||
          header.readUInt32LE(4) !== cpu || header.readUInt32LE(12) !== 2) {
        throw new Error(`Expected a 64-bit Mach-O executable for ${asset.arch}: ${asset.path}`);
      }
    }
  }
  return { ...asset, bytes: stat.size };
}

function packageVersion() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (typeof pkg.version !== 'string' || pkg.version.trim() === '') {
    throw new Error('Expected a package version in package.json');
  }
  return pkg.version;
}

function validateManifest(manifest, version) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.packageVersion !== version ||
      manifest.goVersion !== goVersion || !Array.isArray(manifest.assets) ||
      manifest.assets.length !== required.length) {
    throw new Error('Expected package-assets.json schema 1, current package/Go versions and all nine assets');
  }
  const expected = new Map(required.map(asset => [asset.path, asset]));
  const seen = new Set();
  for (const asset of manifest.assets) {
    const entry = asset && expected.get(asset.path);
    if (!entry || seen.has(asset.path) || asset.kind !== entry.kind ||
        asset.platform !== entry.platform || asset.arch !== entry.arch ||
        !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) {
      throw new Error('Expected unique asset paths with the required kind, platform, architecture and byte count');
    }
    seen.add(asset.path);
    const actual = inspectAsset(entry);
    if (asset.bytes !== actual.bytes) throw new Error(`Packaged byte count differs from the inventory: ${asset.path}`);
  }
}

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--write')) {
    throw new Error('Usage: node scripts/verify-package-assets.mjs [--write]');
  }
  const version = packageVersion();
  if (args[0] === '--write') {
    const assets = required.map(inspectAsset);
    const existing = lstatSync(manifestPath, { throwIfNoEntry: false });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      throw new Error('Expected package-assets.json to be a regular file');
    }
    writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, packageVersion: version, goVersion, assets }, null, 2) + '\n');
    console.log(`Wrote package-assets.json for ${version} (Go ${goVersion}; ${assets.length} executable assets)`);
  } else {
    regularFile(manifestPath);
    validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), version);
  }
  console.log(`Package structural/platform checks OK (${required.length} assets); content identity and source reproducibility are separate scopes`);
} catch (error) {
  console.error(`Package assets: ${error.message}`);
  process.exitCode = 1;
}
