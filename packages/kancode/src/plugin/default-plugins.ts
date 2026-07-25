import { Global } from "@kancode/core/global"
import { Effect } from "effect"
import path from "path"
import { patchPluginConfig } from "./install"

/**
 * First-party plugins seeded into global config on first run.
 *
 * Written unpinned: the whole point of extracting these is that they ship fixes
 * without a KanCode release, and a pinned spec is never rechecked for updates.
 */
export const DEFAULT_PLUGINS = ["@puetsua/kancode-cruise-control"] as const

/** Records which plugins have already been offered, so removal is permanent. */
const MARKER = path.join(Global.Path.state, "default-plugins.json")

type Marker = Record<string, { seeded_at: number; version?: string }>

async function readMarker(): Promise<Marker> {
  const file = Bun.file(MARKER)
  if (!(await file.exists())) return {}
  return (await file.json().catch(() => ({}))) as Marker
}

/**
 * Seeds first-party plugins into the user's global config, once ever.
 *
 * Gated on a state marker rather than on the config contents: `patchPluginConfig`
 * is idempotent only while an entry is present, so keying off config alone would
 * silently re-add a plugin the user deliberately deleted.
 *
 * Never throws — a failure here must not stop startup. The plugin simply is not
 * installed, and permission rules naming it degrade to asking.
 */
export const seedDefaultPlugins = Effect.fn("Plugin.seedDefaultPlugins")(function* (input: {
  directory: string
  worktree: string
}) {
  const marker = yield* Effect.promise(() => readMarker())
  const pending = DEFAULT_PLUGINS.filter((spec) => !marker[spec])
  if (pending.length === 0) return { seeded: [] as string[] }

  const seeded: string[] = []
  for (const spec of pending) {
    const result = yield* Effect.promise(() =>
      patchPluginConfig({
        spec,
        targets: [{ kind: "server" }, { kind: "tui" }],
        global: true,
        directory: input.directory,
        worktree: input.worktree,
      }).catch((error) => ({ ok: false as const, error: String(error) })),
    )
    // Mark regardless of outcome: retrying a failed patch on every start would
    // fight a user who removed the entry between attempts.
    marker[spec] = { seeded_at: Date.now() }
    if ("ok" in result && result.ok) seeded.push(spec)
    else yield* Effect.logWarning("failed to seed default plugin", { spec })
  }

  yield* Effect.promise(() => Bun.write(MARKER, JSON.stringify(marker, null, 2)).catch(() => 0))
  if (seeded.length) yield* Effect.logInfo("seeded default plugins", { plugins: seeded })
  return { seeded }
})
