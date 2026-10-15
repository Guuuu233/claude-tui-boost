import plugin from "./src/index.mjs"

const setupModels = {
  "sonnet": { name: "Claude Sonnet" },
  "opus": { name: "Claude Opus" },
  "haiku": { name: "Claude Haiku" },
}

export async function ClaudeTUIPlugin(input, options) {
  const hooks = await plugin.server(input, options)
  const configure = hooks.config

  return {
    ...hooks,
    async config(config) {
      await configure?.(config)
      const provider = config.provider?.[hooks.auth.provider]
      if (provider && Object.keys(provider.models ?? {}).length === 0) {
        provider.models = structuredClone(setupModels)
      }
    },
  }
}
