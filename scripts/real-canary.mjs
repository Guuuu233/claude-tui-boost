#!/usr/bin/env node
// Explicitly opt-in, bounded live Claude subscription smoke test against a
// SEPARATE, loopback-only plugin Runtime. Never runs external tools or reads
// production history; never prints bridge keys or private SSE payloads.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [stateDir, packageRoot, model = 'claude-haiku-4-5'] = process.argv.slice(2);
const auth = process.env.MAGPIE_REAL_CANARY_AUTHORIZED;
const allowedState = (auth === 'YES' && stateDir?.includes('canary')) ||
  (auth === 'PRODUCTION' && /magpie-tui-runtime-(ntt|production)$/.test(stateDir ?? ''));
if (!allowedState || !packageRoot || !/^[a-zA-Z0-9_-]+$/.test(model)) {
  console.error('Explicit canary authorization, isolated state dir and package root required.');
  process.exit(2);
}
const port = Number(readFileSync(join(stateDir, 'port'), 'utf8').trim());
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid canary port');
const key = readFileSync(join(stateDir, 'key'), 'utf8').trim();
const { createHooks } = await import(pathToFileURL(join(packageRoot, 'src/index.mjs')).href);
const url = `http://127.0.0.1:${port}/v1/`;
const hooks = createHooks({ runtimeURL: url, models: {[model]: {name: model}} });
const session = `release-canary-${process.pid}-${Date.now()}`;
const out = { headers: {} };
hooks['chat.headers']({sessionID: session, model: {providerID: 'claude-tui'}}, out);
const adapter = await hooks.auth.loader(async () => ({type: 'api', key}));
const text = 'For a gateway integration check, reply with only the literal ASCII text MAGPIE_LIVE_CANARY_OK. Do not call tools.';
const body = JSON.stringify({model, messages:[{role:'user',content:text}], stream:true, max_tokens:90});
const started = Date.now();
let response;
try {
  response = await adapter.fetch(`${url}messages`, {method:'POST', headers:out.headers, body,
    signal:AbortSignal.timeout(100_000)});
} catch (err) {
  console.error('CANARY transport exception:',err?.name ?? 'Error', String(err?.message ?? '').slice(0,120));
  process.exit(3);
}
let raw='';
try { raw = await response.text(); }
catch (err) { console.error('CANARY stream failure:',err?.name ?? 'Error'); process.exit(4); }
const content=[];
let eventCount=0, hasToolUse=false;
for (const line of raw.split('\n')) {
  if (!line.startsWith('data: ')) continue;
  let data;
  try { data=JSON.parse(line.slice(6)); } catch {continue;}
  eventCount++;
  if (data?.type==='content_block_start' && data.content_block?.type==='tool_use') hasToolUse=true;
  if (data?.type==='content_block_delta' && typeof data.delta?.text==='string') content.push(data.delta.text);
  if (data?.type==='message_start' && Array.isArray(data.message?.content)) {
    for (const x of data.message.content) if(x?.type==='text') content.push(x.text);
  }
}
const actual=content.join('');
const passed=response.status===200 && actual.includes('MAGPIE_LIVE_CANARY_OK') && !hasToolUse;
console.log(JSON.stringify({status:response.status, duration_s:Number(((Date.now()-started)/1000).toFixed(2)),
  events:eventCount, text_marker_found:actual.includes('MAGPIE_LIVE_CANARY_OK'), unexpected_tool_call:hasToolUse,
  passed}));
if (!passed) process.exit(5);
