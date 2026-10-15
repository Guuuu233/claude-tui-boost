import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('actual Magpie host preserves the public entry request and account contract', { skip: !process.env.MAGPIE_TUI_TEST_HOST, timeout: 40000 }, async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./test/host-contract.mjs', import.meta.url)), process.env.MAGPIE_TUI_TEST_HOST], {
      env: { PATH: process.env.PATH, BUN_BIN: process.execPath }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { output += x; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /PASS actual Magpie host/);
});
