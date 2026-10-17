import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHooks} from '../src/index.mjs';

const message=JSON.stringify({model:'m',messages:[{role:'user',content:'hello'}],max_tokens:30});
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'magpie-live-port-test-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const port=join(dir,'port');
  writeFileSync(port,'37015\n',{mode:0o600});
  return {dir,port};
}
async function plugin(f,transport) {
  const hook=createHooks({runtimeURL:'http://127.0.0.1:37015/v1/',runtimePortFile:f.port,models:{m:{name:'m'}}},transport);
  const out={headers:{}};
  hook['chat.headers']({sessionID:'explicit-desktop-session-id',model:{providerID:'claude-tui'}},out);
  const loader=await hook.auth.loader(async()=>({type:'api',key:'isolated-test-key-16-chars'}));
  return ()=>loader.fetch('http://127.0.0.1:37015/v1/messages',{method:'POST',headers:out.headers,body:message});
}
test('external supervised runtime port moves without gateway restart',async t=>{
  const f=fixture(t),targets=[];
  const send=await plugin(f,async(url)=>{targets.push(url);return new Response('{}',{status:200})});
  assert.equal((await send()).status,200);
  writeFileSync(f.port,'41247\n',{mode:0o600});
  assert.equal((await send()).status,200);
  assert.deepEqual(targets,['http://127.0.0.1:37015/v1/messages','http://127.0.0.1:41247/v1/messages']);
});
test('invalid, writable, or symlinked port file fails closed',async t=>{
  const f=fixture(t);let calls=0;
  const send=await plugin(f,async()=>{calls++;return new Response('{}')});
  for(const invalid of ['0','99999','not-a-port','https://example.com']) {
    writeFileSync(f.port,invalid,{mode:0o600});
    await assert.rejects(send(),/runtime port|port file/i);
  }
  writeFileSync(f.port,'37015\n');
  chmodSync(f.port,0o644);
  await assert.rejects(send(),/private|port file|permissions/i);
  chmodSync(f.port,0o600);
  const link=join(f.dir,'link');symlinkSync(f.port,link);
  await assert.rejects(plugin({...f,port:link},async()=>new Response('{}')).then(fn=>fn()),/symlink|port file/i);
  assert.equal(calls,0);
});
