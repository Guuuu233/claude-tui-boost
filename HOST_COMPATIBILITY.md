# Magpie host compatibility

## Local candidate v0.2.7-rc.1

This repository also tests against the exact upstream `v0.1.1268` commit `63be47717a9ca91fc89102078a1f1fff3e03e0ce`. The bundled runtime and helper are built from the plugin's own `runtime/` source, not from a private Magpie fork.

Magpie v0.1.1268 has a known host-wide hook collision when multiple plugins declare `claude-tui`. Plugin-only mitigation is **fail closed**, not secretly patching Magpie. With exactly one enabled adapter, the plugin's account-key-bound session proof is accepted. Use `magpie-tui-doctor --plugins /path/to/plugins.json --runtime-dir /path/to/runtime-state --service-uid <UID>` for explicitly managed external runtime instances. With plugin-managed per-account runtimes, keep one enabled adapter and use the packaged runtime's own readiness checks. The doctor reads only local metadata; it never rewrites the host config.

The runtime, MCP helper and adapted wrapper ship inside this plugin. Updating Magpie does not rebuild them or turn this provider into Magpie's built-in Claude provider. It can still change the surrounding contract: module loading, sign-in, account/model discovery, gateway API translation, stable conversation ids, hook headers, streaming, cancellation and proxy/process handling.

## Verified boundary

On 2026-10-15 the isolated suites passed against:

- The deployed host source snapshot dated 2026-10-10 (baseline; local evidence).
- Magpie `v0.1.1248`, commit `95e7c6bcc07629897f6703c31eaef477fcee4a13`. Upstream `main` pointed to the same commit when inspected.

Sources: [official plugin contract](https://usemagpie.ai/docs/plugins), [tested host](https://github.com/yetone/magpie/blob/95e7c6bcc07629897f6703c31eaef477fcee4a13/internal/plugin/host.js), [provider boundary](https://github.com/yetone/magpie/blob/95e7c6bcc07629897f6703c31eaef477fcee4a13/docs/subsystems/provider-plugins.md).

`host-compatibility.test.mjs` loads this package's actual public entry in the real upstream Bun host, with isolated HOME/auth files and a synthetic loopback runtime. It checks host options, provider listing, signed request bytes, SSE, same-session tool-result continuation, account isolation, refusal of missing/ephemeral identities, and cancellation reaching the runtime without replay. `first-connect.test.mjs` additionally runs automatic sign-in through that host with fake Claude and the bundled real runtime's readiness handshake. No paid model call or real OAuth is performed.

This does **not** exercise Magpie's entire Go gateway, installed desktop GUI, upstream API translation or real Claude behavior. A host pass is necessary evidence, not a guarantee that every Magpie release or client conversation works. Claude CLI updates are a separate compatibility dependency.

## Continuous checks

The `Magpie host compatibility` GitHub workflow runs on pushes, pull requests, manual dispatch and daily. It tests the verified commit, the current latest release and upstream main. It resolves a moving ref to a commit and records it in the job summary. Failure marks the workflow failed; it does not modify user installations, switch versions or replay a failed request. The release workflow also runs the contract tests against the verified commit, so those checks cannot silently skip during release.

Local reproduction (Bun and tmux required):

```sh
MAGPIE_TUI_TEST_HOST=/absolute/path/to/magpie/internal/plugin/host.js bun test
```

## Updates and rollback

- This is an independent GitHub package, outside `@magpie-community/*` automatic community-package updates. Magpie normally offers its update separately. A Magpie application update can still restart the plugin host and affect an active native session.
- Install without a ref (`magpie plugin add github:Guuuu233/claude-tui-boost`): the main branch is kept at the latest published release, and Magpie offers an update when it moves. A `#tag` or commit pin never shows an update; use one only to hold a specific release deliberately. Check the installed commit in Magpie.
- Before a Magpie upgrade, finish active tool calls and keep the previous Magpie binary/version and private state backup. Verify sign-in, a fresh conversation, a harmless tool-result round trip and cancellation before continuing important work. Do not use an old uncertain Write/Edit/Bash request as an upgrade probe.
- Missing stable conversation identity or valid hook proof is refused. No guessed session id or automatic uncertain tool replay is introduced for compatibility. Rollback of binaries is not permission to delete checkpoints or reuse partially completed tool calls.
