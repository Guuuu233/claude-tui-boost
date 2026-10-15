import { describe, expect, test } from "bun:test"
import { ClaudeTUIPlugin } from "./index.mjs"

describe("Claude TUI independent entry", () => {
  test("loads without starting Claude and exposes the provider contract", async () => {
    const hooks = await ClaudeTUIPlugin({ directory: process.cwd() })

    expect(hooks.auth.provider).toBe("claude-tui")
    expect(typeof hooks.auth.loader).toBe("function")
    expect(hooks.auth.methods).toHaveLength(2)
    expect(hooks.auth.methods[0].type).toBe("oauth")
    expect(typeof hooks.auth.methods[0].authorize).toBe("function")

    const config = { provider: {} }
    await hooks.config(config)
    expect(config.provider["claude-tui"].npm).toBe("@ai-sdk/anthropic")
    expect(Object.keys(config.provider["claude-tui"].models)).toEqual(["sonnet", "opus", "haiku"])
  })
})

// The installed entry must preserve Magpie's documented second argument.
test("public entry forwards explicit host options", async () => {
  const hooks = await ClaudeTUIPlugin({}, { runtimeURL: "http://127.0.0.1:12345/v1/", models: { custom: { name: "Custom model" } } })
  const config = {}
  await hooks.config(config)
  expect(Object.keys(config.provider["claude-tui"].models)).toEqual(["custom"])
  expect(config.provider["claude-tui"].api).toBe("http://127.0.0.1:12345/v1/")
})
