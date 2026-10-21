/**
 * Cross-process regression: packaged JS adapter -> signed HTTP -> actual Go
 * Runtime -> synthetic native MCP handoff -> signed tool_result -> same PTY.
 * Every tool/Claude process is synthetic. No real credentials or production
 * services, no side-effecting tools, and no prompt is sent to Anthropic.
 */
import {test, expect} from "bun:test";
import {spawn} from "node:child_process";
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {setTimeout as delay} from "node:timers/promises";
import {createHooks} from "../src/index.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const arch = process.arch === "x64" ? "amd64" : process.arch;
const binary = join(root, "bin", `magpie-tui-runtime.${process.platform}-${arch}`);

async function waitFor(fn, limit = 10_000) {
  const until = Date.now() + limit;
  while (Date.now() < until) {
    const got = fn();
    if (got !== undefined && got !== false) return got;
    await delay(20);
  }
  throw Error("synthetic MCP bridge timed out waiting for state");
}

test("signed packaged MCP tool handoff resumes its exact native run without replay", {timeout: 35_000}, async () => {
  expect(existsSync(binary)).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), "magpie-mcp-roundtrip-"));
  let child;
  let stderr = "";
  try {
    const home = join(dir, "home"), state = join(dir, "state"), bin = join(dir, "bin");
    mkdirSync(home, {mode: 0o700});
    mkdirSync(state, {mode: 0o700});
    mkdirSync(bin, {mode: 0o700});
    const claude = join(bin, "claude");
    writeFileSync(claude, '#!/bin/sh\n[ "${1:-}" = "--version" ] && { echo "2.1.296 (offline test stub)"; exit 0; }\necho "Real inference is forbidden" >&2\nexit 93\n', {mode: 0o700});
    chmodSync(claude, 0o700);
    const wrapper = join(dir, "fake-native-claude.sh");
    const mcpFile = join(dir, "mcp-config.json"), releaseFile = join(dir, "release");
    writeFileSync(wrapper, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--mcp-config" ]; then
    printf '%s' "$2" > "$SYNTHETIC_MCP_CONFIG_FILE"
    shift 2
  else
    shift
  fi
done
cat >/dev/null
printf '%s\\n' '{"type":"assistant","uuid":"tool","session_id":"inner-synthetic","message":{"id":"tool1","model":"claude-tui","content":[{"type":"tool_use","id":"fake_call_1","name":"mcp__magpie__echo_test","input":{"text":"hello"}}]}}'
i=0
while [ ! -f "$SYNTHETIC_MCP_RELEASE_FILE" ] && [ "$i" -lt 250 ]; do sleep .05; i=$((i+1)); done
if [ ! -f "$SYNTHETIC_MCP_RELEASE_FILE" ]; then exit 18; fi
printf '%s\\n' '{"type":"assistant","uuid":"answer","session_id":"inner-synthetic","message":{"id":"answer1","model":"claude-tui","content":[{"type":"text","text":"SYNTHETIC_MCP_RESUMED_OK"}]}}'
printf '%s\\n' '{"type":"result","session_id":"inner-synthetic","stop_reason":"end_turn","is_error":false}'
`, {mode: 0o700});
    chmodSync(wrapper, 0o700);
    const portFile = join(dir, "port"), keyFile = join(dir, "key"), modelsFile = join(dir, "models");
    const env = {...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"),
      XDG_CACHE_HOME: join(home, "cache"), CLAUDE_CONFIG_DIR: join(home, "claude"), PATH: `${bin}:${process.env.PATH ?? ""}`,
      SYNTHETIC_MCP_CONFIG_FILE: mcpFile, SYNTHETIC_MCP_RELEASE_FILE: releaseFile};
    for (const key of Object.keys(env)) {
      if (key.startsWith("ANTHROPIC_") || key.startsWith("MAGPIE_") || key === "CLAUDE_CODE_USE_BEDROCK") delete env[key];
    }
    child = spawn(binary, ["--serve", "--state-dir", state, "--port-file", portFile, "--key-file", keyFile,
      "--models-file", modelsFile, "--bridge", wrapper, "--helper", "/bin/false", "--models", "claude-tui"],
    {env, stdio: ["ignore", "ignore", "pipe"]});
    child.stderr.on("data", chunk => { if (stderr.length < 3000) stderr += String(chunk).slice(0, 3000); });
    const port = await waitFor(() => existsSync(portFile) && existsSync(keyFile) && Number(readFileSync(portFile, "utf8")));
    const url = `http://127.0.0.1:${port}/v1/`;
    const key = readFileSync(keyFile, "utf8");
    const hooks = createHooks({runtimeURL: url, models: {"claude-tui": {name: "Synthetic"}}});
    const adapter = await hooks.auth.loader(async () => ({type: "api", key}));
    const headerOutput = {headers: {}};
    hooks["chat.headers"]({sessionID: "offline-synthetic-mcp-roundtrip", model: {providerID: "claude-tui"}}, headerOutput);
    const tools = [{name: "echo_test", description: "Synthetic echo, no side effects", input_schema: {type: "object", properties: {text: {type: "string"}}}}];
    const messages = [{role: "user", content: "Call echo_test in a synthetic test."}];
    const send = async (current) => {
      const body = JSON.stringify({model: "claude-tui", max_tokens: 128, stream: true, tools, messages: current});
      const response = await adapter.fetch(url + "messages", {method: "POST", headers: headerOutput.headers,
        body, signal: AbortSignal.timeout(18_000)});
      const payload = await response.text();
      return {status: response.status, payload};
    };
    const first = await send(messages);
    expect(first.status).toBe(200);
    expect(first.payload).toContain('"type":"tool_use"');
    expect(first.payload).toContain("fake_call_1");
    // The private MCP callback itself is the only native tool execution
    // signal. It stays pending until Desktop submits its result separately.
    const mcpConfig = await waitFor(() => {
      if (!existsSync(mcpFile)) return undefined;
      try { return JSON.parse(readFileSync(mcpFile, "utf8")); }
      catch { return undefined; }
    });
    const server = mcpConfig.mcpServers?.magpie;
    const callback = server?.args?.find(x => typeof x === "string" && x.startsWith("http://127.0.0.1:"));
    expect(callback).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/_magpie\/claude-mcp\/[\w-]+$/);
    expect(server.timeout).toBe(80 * 60 * 1000);

    // A client supplying the wrong tool id must be rejected without touching
    // the original callback owner or executing another request.
    const call = {type: "tool_use", id: "fake_call_1", name: "echo_test", input: {text: "hello"}};
    const bad = await send([...messages, {role: "assistant", content: [call]},
      {role: "user", content: [{type: "tool_result", tool_use_id: "different_id", content: "hello"}]}]);
    expect(bad.status).toBe(409);

    const posted = fetch(callback, {method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({tool_call_id: "fake_call_1", name: "echo_test", arguments: {text: "hello"}}),
      signal: AbortSignal.timeout(15_000)}).then(async response => {
      const payload = await response.text();
      expect(response.status).toBe(200);
      expect(payload).toContain("hello");
      writeFileSync(releaseFile, "ok", {mode: 0o600});
      return payload;
    });
    const correct = await send([...messages, {role: "assistant", content: [call]},
      {role: "user", content: [{type: "tool_result", tool_use_id: "fake_call_1", content: "hello"}]}]);
    await posted;
    expect(correct.status).toBe(200);
    expect(correct.payload).toContain("SYNTHETIC_MCP_RESUMED_OK");

    // The native run has ended. A duplicate must never be treated as an
    // invitation to execute the already completed external tool again.
    // Lite may answer it via a detached tool-free explanatory request.
    const replay = await send([...messages, {role: "assistant", content: [call]},
      {role: "user", content: [{type: "tool_result", tool_use_id: "fake_call_1", content: "hello"}]}]);
    expect(replay.status).toBe(200);
    expect(replay.payload).toContain("SYNTHETIC_MCP_RESUMED_OK");
    expect(replay.payload).not.toContain('"type":"tool_use"');
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(1000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    rmSync(dir, {recursive: true, force: true});
  }
});
