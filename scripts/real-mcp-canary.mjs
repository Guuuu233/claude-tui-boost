#!/usr/bin/env node
// Explicit opt-in live Claude TUI smoke test with one harmless client-side
// echo tool. Never executes shell commands or replays a tool after an error.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const [stateDir, packageRoot, model='claude-haiku-4-5'] = process.argv.slice(2);
const auth=process.env.MAGPIE_REAL_CANARY_AUTHORIZED;
const allowedState=(auth==='YES' && stateDir?.includes('canary')) ||
  (auth==='PRODUCTION' && /magpie-tui-runtime-(ntt|production)$/.test(stateDir??''));
if (!allowedState || !packageRoot || !/^[\w-]+$/.test(model)) {
  console.error('Explicit isolated canary authorization required');
  process.exit(2);
}
const port=Number(readFileSync(join(stateDir,'port'),'utf8').trim());
const key=readFileSync(join(stateDir,'key'),'utf8').trim();
const {createHooks}=await import(pathToFileURL(join(packageRoot,'src/index.mjs')).href);
const url=`http://127.0.0.1:${port}/v1/`;
const hooks=createHooks({runtimeURL:url,models:{[model]:{name:model}}});
const out={headers:{}};
hooks['chat.headers']({model:{providerID:'claude-tui'},sessionID:`real-mcp-canary-${process.pid}-${Date.now()}`},out);
const adapter=await hooks.auth.loader(async()=>({type:'api',key}));
const tools=[{name:'canary_echo',description:'An echo-only synthetic tool. The client will supply a constant result; no external process, shell, or filesystem operation happens.',input_schema:{type:'object',properties:{message:{type:'string'}},required:['message']}}];
const user={role:'user',content:'You MUST call the provided canary_echo tool exactly once with message HELLO_CANARY. After the tool returns, reply with only CANARY_MCP_COMPLETE. Do not use any other tools.'};
function unpack(raw) {
  const blocks=[],parts=[],events=[];
  for (const ln of raw.split('\n')) {
    if (!ln.startsWith('data: ')) continue;
    let d;try{d=JSON.parse(ln.slice(6));}catch{continue;}
    if (d?.type)events.push(d.type);
    if(d?.type==='content_block_start'&&d.content_block?.type==='tool_use')blocks.push(d.content_block);
    if(d?.type==='content_block_delta'&&typeof d.delta?.text==='string')parts.push(d.delta.text);
    if(d?.type==='message_start'&&Array.isArray(d.message?.content)) {
      for (const b of d.message.content) if(b?.type==='tool_use')blocks.push(b);else if(b?.type==='text')parts.push(b.text);
    }
  }
  return {blocks,reply:parts.join(''),events:events.length};
}
const send=async messages=>{
  const payload=JSON.stringify({model,messages,tools,stream:true,max_tokens:220});
  const response=await adapter.fetch(url+'messages',{method:'POST',headers:out.headers,body:payload,signal:AbortSignal.timeout(125_000)});
  const raw=await response.text();
  return {status:response.status,...unpack(raw)};
};
const started=Date.now();
try {
  const first=await send([user]);
  const call=first.blocks.find(x=>x.name==='canary_echo'&&typeof x.id==='string');
  console.log(JSON.stringify({step:'tool_use',status:first.status,events:first.events,tool_returned:Boolean(call),s:Number(((Date.now()-started)/1000).toFixed(1))}));
  if(first.status!==200||!call)process.exit(4);
  const assistant={role:'assistant',content:[{type:'tool_use',id:call.id,name:'canary_echo',input:{message:'HELLO_CANARY'}}]};
  const result={role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:'HELLO_CANARY ACKNOWLEDGED'}]};
  const second=await send([user,assistant,result]);
  const ok=second.status===200&&second.reply.includes('CANARY_MCP_COMPLETE');
  console.log(JSON.stringify({step:'tool_result',status:second.status,events:second.events,
    marker_found:second.reply.includes('CANARY_MCP_COMPLETE'),s:Number(((Date.now()-started)/1000).toFixed(1)),passed:ok}));
  if(!ok)process.exit(5);
} catch(e) {
  console.error('CANARY_MCP_EXCEPTION',e?.name??'Error',String(e?.message??'').slice(0,115));
  process.exit(6);
}
