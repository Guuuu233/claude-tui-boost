# v0.2.4 — Claude Desktop compaction with isolated history

This maintenance release fixes Claude Desktop `/compact` requests that include completed historical tool calls and results. It is an **unofficial, experimental third-party** provider; not reviewed or endorsed by Magpie or Anthropic.

## Changes

- Recognize Claude Code's dedicated compaction request and route it through a separate native Claude Code session.
- Preserve user/assistant turns and structured tool results and images; include any system prompt as labelled archival context. The new summary turn has no tools, so historical tool calls are not re-executed.
- Keep the original conversation checkpoint separate; compaction does not resume or replace it.
- Retain v0.2.3 history-continuity and bounded read-only recovery behavior.

## Data handling

To seed the isolated summary session, the full source history, including tool content and images, is written as an additional JSONL transcript under the configured Claude Code profile. The summary is sent through that profile's normal Claude Code authentication path. This adds a local transcript copy that can remain under the CLI's normal session-retention behavior; the original conversation checkpoint remains separate. Keep the Claude profile private and review its session files if you need to remove that copy.

## Limits and safe upgrades

This fixes the dedicated `/compact` request shape. It does **not** guarantee that unrelated HTTP 409/502 errors disappear, revive dead MCP callbacks, or authorize replay of uncertain `Edit`/`Write`/`Bash` effects. Verify actual files and results before retrying an interrupted side-effecting tool. CI uses synthetic/non-inferencing Claude and isolated Magpie host tests; it does not exercise real OAuth or GUI sessions.

### Install / update

```sh
magpie plugin add github:Guuuu233/magpie-claude-tui-plugin#v0.2.4
magpie plugin login claude-tui
```

If already connected, use Magpie's installed-plugin update mechanism after completing active tools, then verify a new harmless request. Do not reset existing checkpoints or remove a running session solely to upgrade.
