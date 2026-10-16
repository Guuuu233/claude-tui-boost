import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectDeployment } from './src/deployment-preflight.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'magpie-tui-doctor-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, 'plugins.json');
  const state = join(dir, 'runtime');
  mkdirSync(state, { mode: 0o700 });
  const port = join(state, 'port');
  const put = (items) => {
    writeFileSync(config, JSON.stringify({ plugins: items }), { mode: 0o600 });
    chmodSync(config, 0o600);
  };
  writeFileSync(port, '37015\n', { mode: 0o600 });
  const adapter = (portNumber = 37015, off = false, spec = 'github:Guuuu233/magpie-claude-tui-plugin#v0.2.6') =>
    ({ spec, off, options: { runtimeURL: `http://127.0.0.1:${portNumber}/v1/` } });
  const inspect = () => inspectDeployment({ pluginsPath: config, runtimeDir: state, serviceUid: process.getuid?.() });
  return { dir, config, state, port, put, adapter, inspect };
}

test('accepts one selected plugin and current private loopback runtime', t => {
  const f = fixture(t);
  f.put([f.adapter(), { spec: 'unrelated', options: {} }]);
  assert.equal(f.inspect().ok, true);
  assert.equal(f.inspect().activeAdapters, 1);
});

test('rejects duplicated enabled plugin instances', t => {
  const f = fixture(t);
  f.put([f.adapter(), f.adapter(37015, false, '/tmp/magpie-claude-tui-plugin')]);
  assert.equal(f.inspect().ok, false);
});

test('rejects stale port and non-loopback URL', t => {
  const f = fixture(t);
  f.put([f.adapter(40143)]);
  assert.equal(f.inspect().ok, false);
  f.put([{ ...f.adapter(), options: { runtimeURL: 'http://example.org:37015/v1/' } }]);
  assert.equal(f.inspect().ok, false);
});

test('rejects publicly readable and incorrectly owned plugin configuration', t => {
  const f = fixture(t);
  f.put([f.adapter()]);
  chmodSync(f.config, 0o644);
  assert.equal(f.inspect().ok, false);
  chmodSync(f.config, 0o600);
  assert.equal(inspectDeployment({ pluginsPath: f.config, runtimeDir: f.state,
    serviceUid: (process.getuid?.() ?? 1000) + 1 }).ok, false);
});

test('rejects symlink or publicly readable runtime port file', t => {
  const f = fixture(t);
  f.put([f.adapter()]);
  const link = join(f.dir, 'link');
  symlinkSync(f.state, link);
  assert.equal(inspectDeployment({ pluginsPath: f.config, runtimeDir: link,
    serviceUid: process.getuid?.() }).ok, false);
  chmodSync(f.port, 0o644);
  assert.equal(f.inspect().ok, false);
});

test('disabled stale plugin is only a warning', t => {
  const f = fixture(t);
  f.put([f.adapter(), f.adapter(40143, true, '/tmp/magpie-claude-tui-plugin')]);
  const result = f.inspect();
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
});

test('does not emit any plugin credentials or stored keys', t => {
  const f = fixture(t);
  const secret = 'SYNTHETIC_PRIVATE_MATERIAL_NEVER_LOG';
  f.put([{ ...f.adapter(), secret, options: { runtimeURL: `http://127.0.0.1:37015/v1/`, credentials: secret } }]);
  assert.equal(JSON.stringify(f.inspect()).includes(secret), false);
});
