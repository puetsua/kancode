import type { PluginInput } from "@kancode/plugin"
import { mkdir } from "fs/promises"
import path from "path"

/**
 * Minimal PluginInput for plugins that only exercise auth/provider hooks.
 * `model.generate` rejects so an accidental call is loud rather than silent.
 */
export function fakePluginInput(override: Partial<PluginInput> = {}): PluginInput {
  return {
    client: {} as never,
    project: {} as never,
    directory: "",
    worktree: "",
    paths: { config: "", data: "", cache: "", state: "", tmp: "" },
    model: {
      generate: async () => {
        throw new Error("fakePluginInput.model.generate not configured")
      },
    },
    experimental_workspace: { register() {} },
    permission: { registerModule() {} },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
    ...override,
  }
}

export async function markPluginDependenciesReady(dir: string) {
  await mkdir(path.join(dir, "node_modules"), { recursive: true })
  await Bun.write(
    path.join(dir, "package-lock.json"),
    JSON.stringify({ packages: { "": { dependencies: { "@kancode/plugin": "0.0.0" } } } }),
  )
}
