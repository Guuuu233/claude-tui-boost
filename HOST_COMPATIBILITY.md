# Magpie host compatibility

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
- For deliberate updates use a published tag, e.g. `magpie plugin add github:Guuuu233/magpie-claude-tui-plugin#v0.2.3`. For a strict immutable pin use that release's full commit SHA. Git tags can move; an explicit plugin Update action can change the selected pin. Check the installed commit in Magpie.
- Before a Magpie upgrade, finish active tool calls and keep the previous Magpie binary/version and private state backup. Verify sign-in, a fresh conversation, a harmless tool-result round trip and cancellation before continuing important work. Do not use an old uncertain Write/Edit/Bash request as an upgrade probe.
- Missing stable conversation identity or valid hook proof is refused. No guessed session id or automatic uncertain tool replay is introduced for compatibility. Rollback of binaries is not permission to delete checkpoints or reuse partially completed tool calls.
