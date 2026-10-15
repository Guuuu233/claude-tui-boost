// Executes the inspected Magpie host itself, with an isolated HOME and local
// synthetic HTTP runtime. No Claude, native credentials or production service.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createHash, createHmac } from "node:crypto";
import assert from "node:assert/strict";

const hostSource = process.argv[2];
if (!hostSource) throw new Error("Magpie host.js source path required");
const folder = await mkdtemp(join(tmpdir(), "magpie-tui-host-test-"));
const keyA = "public-synthetic-plugin-host-key-A";
const keyB = "public-synthetic-plugin-host-key-B";
const captures = [];
let slowClosed;
const closed = new Promise(r => { slowClosed = r; });
const runtime = createServer(async (request, response) => {
  const pieces = [];
  for await (const piece of request) pieces.push(piece);
  const body = Buffer.concat(pieces).toString("utf8");
  const canonical = ["bridge-auth-v1", "POST", "/v1/messages", request.headers["x-bridge-timestamp"],
    request.headers["x-bridge-nonce"], request.headers["x-bridge-session"],
    createHash("sha256").update(body).digest("hex")].join("\n");
  const selected = [keyA, keyB].find(key =>
    createHmac("sha256", key).update(canonical).digest("hex") === request.headers["x-bridge-mac"]);
  if (!selected) { response.writeHead(403); response.end(); return; }
  captures.push({ body, headers: request.headers, key: selected });
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (JSON.parse(body).slow) {
    response.on('close', slowClosed);
    response.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    return;
  }
  response.end('event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
});
await new Promise(resolve => runtime.listen(0, "127.0.0.1", resolve));
const runtimeURL = `http://127.0.0.1:${runtime.address().port}/v1/`;
const authPath = join(folder, "plugin-auth.json");
await writeFile(authPath, JSON.stringify({
  "claude-tui": { type: "api", key: keyA },
  "claude-tui#other": { type: "api", key: keyB },
}), { mode: 0o600 });
const child = spawn(process.env.BUN_BIN ?? "bun", [hostSource], {
  cwd: folder,
  env: { PATH: process.env.PATH, HOME: folder, XDG_CONFIG_HOME: folder, XDG_CACHE_HOME: folder },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", chunk => { stderr += chunk; });
const waiting = new Map();
let nextId = 1;
const lines = createInterface({ input: child.stdout });
lines.on("line", line => {
  const message = JSON.parse(line);
  const task = waiting.get(message.id);
  if (!task) return;
  task.messages.push(message);
  if (task.onEvent?.(message)) {
    clearTimeout(task.timer);
    waiting.delete(message.id);
    task.reject(new Error("client canceled fetch"));
    return;
  }
  if ("result" in message || message.error) {
    clearTimeout(task.timer);
    waiting.delete(message.id);
    message.error ? task.reject(new Error(message.error.message)) : task.resolve(task.messages);
  }
});
const exited = new Promise(resolve => child.once("exit", (code, signal) => {
  for (const task of waiting.values()) { clearTimeout(task.timer); task.reject(new Error(`host exit ${code}/${signal}: ${stderr}`)); }
  waiting.clear();
  resolve({ code, signal });
}));
function rpc(method, params, onEvent) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`host timeout: ${method}`)); }, 10000);
    waiting.set(id, { resolve, reject, timer, messages: [], onEvent });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

try {
  const init = await rpc("init", {
    authPath, directory: folder,
    plugins: [{
      spec: "magpie-claude-tui-local",
      target: new URL("../index.mjs", import.meta.url).pathname,
      options: { runtimeURL, models: { "runtime-model": { name: "Runtime model", limit: { context: 8192, output: 1024 } } } },
    }],
  });
  assert.equal(init.at(-1).result.plugins[0].error, undefined);
  const providers = (await rpc("providers", {})).at(-1).result;
  assert.ok(JSON.stringify(providers).includes("claude-tui"));
  assert.ok(JSON.stringify(providers).includes("runtime-model"));
  const body = '{ "model":"runtime-model", "system":"preserve", "messages":[{"role":"user","content":"hello"}], "stream":true }';
  async function fetch(account, session, payload = body) {
    const result = await rpc("fetch", {
      provider: "claude-tui", account, model: "runtime-model", npm: "@ai-sdk/anthropic",
      url: runtimeURL + "messages", method: "POST", headers: {},
      body: Buffer.from(payload).toString("base64"), session, window: 512 << 10,
    });
    assert.equal(result.find(message => message.event === "head").status, 200);
    const stream = result.filter(message => message.event === "chunk").map(message => Buffer.from(message.data, "base64").toString()).join("");
    assert.ok(stream.includes("message_stop"));
  }
  await fetch("claude-tui", "conversation-A");
  await fetch("claude-tui", "conversation-A", '{"model":"runtime-model","messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-A","content":"done"}]}],"stream":true}');
  await fetch("claude-tui#other", "conversation-A");
  assert.equal(captures[0].body, body);
  assert.equal(captures[0].headers["x-bridge-session"], captures[1].headers["x-bridge-session"]);
  assert.notEqual(captures[0].headers["x-bridge-session"], captures[2].headers["x-bridge-session"]);
  assert.equal(captures[2].key, keyB);
  await assert.rejects(fetch("claude-tui", "magpie-" + "a".repeat(24)));
  assert.equal(captures.length, 3);
  await assert.rejects(fetch("claude-tui", ""));
  assert.equal(captures.length, 3, "missing identity must fail before contacting runtime");
  const slowBody = JSON.stringify({ model: "runtime-model", messages: [], stream: true, slow: true });
  await assert.rejects(rpc("fetch", {
    provider: "claude-tui", account: "claude-tui", model: "runtime-model", npm: "@ai-sdk/anthropic",
    url: runtimeURL + "messages", method: "POST", headers: {},
    body: Buffer.from(slowBody).toString("base64"), session: "conversation-slow", window: 512 << 10,
  }, message => {
    if (message.event === "head") {
      child.stdin.write(JSON.stringify({ method: "abort", params: { id: message.id } }) + "\n");
      // The host intentionally sends no terminal frame for an abandoned RPC.
      return true;
    }
  }));
  let closeTimer;
  try { await Promise.race([closed, new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error("runtime did not receive cancellation")), 3000); })]); }
  finally { clearTimeout(closeTimer); }
  assert.equal(captures.length, 4, "abort must not replay the request");
  console.log("PASS actual Magpie host: public options, listing, signed fetch, SSE, tool continuation, account separation, identity refusal, cancellation without replay");
} finally {
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  await exited;
  clearTimeout(timer);
  lines.close();
  await new Promise(resolve => runtime.close(resolve));
  await rm(folder, { recursive: true, force: true });
}
