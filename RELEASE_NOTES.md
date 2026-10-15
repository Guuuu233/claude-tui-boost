# v0.2.2 — managed settings and Magpie host compatibility

Fixes recovery environment propagation through managed startup (five boolean flags only; still opt-in), unsigned-in model placeholders, and forwarding of explicit Magpie plugin options. Private legacy certificates are not inherited. Arbitrary MANAGED_RUNTIME_EXTRA_ENV forwarding is removed.

Includes RECOVERY.md and HOST_COMPATIBILITY.md in installed packages and refreshes compatibility documentation. Adds actual-host contract checks and daily compatibility CI against a verified commit, the latest Magpie release and upstream main. Release tests use the verified host so they cannot skip silently.

Local evidence: isolated Bun/tmux tests against the deployed host snapshot and Magpie v0.1.1248/main commit 95e7c6bcc07629897f6703c31eaef477fcee4a13. Real new-user OAuth, full GUI installation and the entire Go gateway are not covered by the host contract test. No production service or existing account was modified. Future Magpie/Claude compatibility is not guaranteed.

Unofficial experimental third-party plugin; not reviewed or endorsed by Magpie or Anthropic. Native Windows/WSL unsupported; macOS amd64/Linux arm64 cross-built only. See README for effects and limitations.
