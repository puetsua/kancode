import type { Hooks, Plugin, PluginInput } from "@kancode/plugin"
import { clearDynamicLists, decideCruiseControl, type ClassifierLogger, type PermissionModuleSchema } from "./classifier"

/** Module id this plugin registers. Matches `permission_modules.cruise_control`. */
export const CRUISE_CONTROL = "cruise_control"

/** Window during which a config read is reused. Long enough to absorb a burst of
 * parallel classifications, short enough that `/cruise-control-model` takes effect
 * without a restart. */
export const CONFIG_TTL_MS = 5_000

/**
 * Reads `permission_modules.cruise_control` per decision through the public SDK.
 *
 * Deliberately not the `config` hook: that fires once at plugin init, so a model
 * chosen mid-session would not apply until restart.
 */
export function makeOptionsReader(client: PluginInput["client"], now: () => number = Date.now) {
  // -Infinity, not 0: with 0 the first call looks fresh whenever the clock reads
  // below the TTL, and would hand back the empty cache instead of fetching.
  let cachedAt = Number.NEGATIVE_INFINITY
  let cached: PermissionModuleSchema.Options | undefined
  let inflight: Promise<PermissionModuleSchema.Options | undefined> | undefined

  return async () => {
    if (now() - cachedAt < CONFIG_TTL_MS) return cached
    inflight ??= client.config
      .get()
      .then((response) => {
        const config = ((response as { data?: unknown }).data ?? response) as
          | { permission_modules?: Record<string, PermissionModuleSchema.Options> }
          | undefined
        return config?.permission_modules?.[CRUISE_CONTROL]
      })
      .catch(() => cached)
      .finally(() => {
        inflight = undefined
      })
    cached = await inflight
    cachedAt = now()
    return cached
  }
}

/**
 * Cruise Control plugin: registers permission module `cruise_control` via the
 * public `permission.registerModule` API.
 *
 * Disabled with other default plugins when `disableDefaultPlugins` is set.
 *
 * Default classifier instructions are applied at decision time, never written
 * into the user's config: they would go stale on every update in a file the
 * user never edited, and improved defaults should ship with the code.
 *
 * Clears the per-prompt dynamic allow/deny lists on each new user message
 * (`chat.message`) so learned decisions do not leak across prompt turns.
 */
export function createCruiseControlPlugin(log?: ClassifierLogger): Plugin {
  return async (input: PluginInput): Promise<Hooks> => {
    const readOptions = makeOptionsReader(input.client)
    input.permission.registerModule({
      id: CRUISE_CONTROL,
      decide: async (req) => {
        const result = await decideCruiseControl({
          model: input.model,
          paths: input.paths,
          options: await readOptions(),
          log,
          moduleID: CRUISE_CONTROL,
          permission: req.permission,
          patterns: req.patterns,
          metadata: req.metadata,
          userPrompt: req.userPrompt,
          sessionContext: req.sessionContext,
          approvalPrompt: req.approvalPrompt,
          cacheScope: req.cacheScope,
        })
        return {
          decision: result.decision,
          reason: result.reason,
          ...("review" in result ? { metadata: result.review } : {}),
        }
      },
    })

    return {
      "chat.message": async ({ sessionID }) => {
        clearDynamicLists(`${input.directory}\0${sessionID}`)
      },
    }
  }
}
