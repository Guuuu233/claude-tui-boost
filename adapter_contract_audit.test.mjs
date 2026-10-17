import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { createHooks } from './src/index.mjs';

const url = 'http://127.0.0.1:43991/v1/';
const models = { 'claude-opus-5-5': { id: 'claude-opus-5-5' } };
const key = 'sandbox-only-password-not-a-live-key-123456';
const sign = (k, data) => createHmac('sha256', k).update(data).digest('hex');
const sha = (data) => createHash('sha256').update(data).digest('hex');
const body = JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'sandbox ping' }] });

const make = (transport) => {
  const hook = createHooks({ runtimeURL: url, models }, transport);
  const out = { headers: {} };
  const stamp = (sessionID) => hook['chat.headers']({ model: { providerID: 'claude-tui' }, sessionID }, out);
  return { hook, out, stamp, load: () => hook.auth.loader(async () => ({ type: 'api', key })) };
};

test('stable session is tied to a private HMAC and native transport response is untouched', async () => {
  const seen = [];
  const x = make(async (target, args) => {
    seen.push({ target, args });
    return new Response('data: native\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  x.stamp('desktop-canonical-sandbox-1');
  const loader = await x.load();
  const result = await loader.fetch(url + 'messages', { method: 'POST', headers: x.out.headers, body });
  assert.equal(result.status, 200);
  assert.equal(await result.text(), 'data: native\n\n');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].target, url + 'messages');
  assert.equal(seen[0].args.body, body);
  const hdr = new Headers(seen[0].args.headers);
  assert.equal(hdr.get('x-bridge-auth-version'), '1');
  assert.equal(hdr.get('x-bridge-session'), sign(key, 'magpie-bridge-account/v1\0' + sha('magpie-interactive-bridge/v1\0desktop-canonical-sandbox-1')));
  const canonical = ['bridge-auth-v1', 'POST', '/v1/messages', hdr.get('x-bridge-timestamp'), hdr.get('x-bridge-nonce'), hdr.get('x-bridge-session'), sha(body)].join('\n');
  assert.equal(hdr.get('x-bridge-mac'), sign(key, canonical));
  assert.equal(hdr.has('x-g3-hook-proof'), false, 'plugin-private proof must not reach the runtime');
  assert.equal(hdr.has('authorization'), false, 'the credential must not be leaked in transport headers');
});

test('missing or synthetic session id fails before signing or fetching', async () => {
  let calls = 0;
  const x = make(async () => { calls++; return new Response('should not run'); });
  for (const id of ['', null, 'magpie-' + 'f'.repeat(24), 'invalid\nheader']) {
    assert.throws(() => x.stamp(id), /explicit stable conversation id/);
  }
  const loader = await x.load();
  await assert.rejects(loader.fetch(url + 'messages', { method: 'POST', body }), /conversation context was not supplied by its hook/);
  assert.equal(calls, 0);
});

test('a forged hook session/proof cannot start a runtime request', async () => {
  let calls = 0;
  const x = make(async () => { calls++; return new Response('should not run'); });
  x.stamp('sandbox-forged-session');
  const loader = await x.load();
  const forged = { ...x.out.headers, 'x-g3-hook-proof': '0'.repeat(64) };
  await assert.rejects(loader.fetch(url + 'messages', { method: 'POST', headers: forged, body }), /conversation context was not supplied by its hook/);
  assert.equal(calls, 0);
});

test('cross-plugin proof cannot be handed to another plugin instance', async () => {
  let calls = 0;
  const a = make(async () => new Response('not relevant'));
  const b = make(async () => { calls++; return new Response('should not run'); });
  a.stamp('stable-conversation-1');
  const otherLoader = await b.load();
  await assert.rejects(otherLoader.fetch(url + 'messages', { method: 'POST', headers: a.out.headers, body }), /conversation context was not supplied by its hook/);
  assert.equal(calls, 0);
});

test('cancelled or oversized request is rejected without upstream side effects', async () => {
  let calls = 0;
  const x = make(async () => { calls++; return new Response('should not run'); });
  x.stamp('sandbox-cancel-and-size');
  const loader = await x.load();
  const ctl = new AbortController();
  ctl.abort(new Error('synthetic cancellation'));
  await assert.rejects(loader.fetch(url + 'messages', { method: 'POST', headers: x.out.headers, body, signal: ctl.signal }), /synthetic cancellation/);
  await assert.rejects(loader.fetch(url + 'messages', { method: 'POST', headers: x.out.headers, body: 'x'.repeat((16 << 20) + 1) }), /exceeds 16 MiB/);
  assert.equal(calls, 0);
});

test('runtime redirects and non-loopback target are refused', async () => {
  let calls = 0;
  const x = make(async () => { calls++; return new Response('', { status: 307, headers: { location: 'http://example.com/' } }); });
  x.stamp('sandbox-redirect');
  const loader = await x.load();
  await assert.rejects(loader.fetch(url + 'messages', { method: 'POST', headers: x.out.headers, body }), /redirects are refused/);
  await assert.rejects(loader.fetch('http://example.com/v1/messages', { method: 'POST', headers: x.out.headers, body }), /only the configured messages endpoint/);
  assert.equal(calls, 1);
});
