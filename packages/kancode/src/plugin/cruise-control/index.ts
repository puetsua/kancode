import type { Hooks, Plugin, PluginInput } from "@kancode/plugin"
import { PermissionModule as PermissionModuleSchema } from "@kancode/schema/permission-module"
import { EffectBridge } from "@/effect/bridge"
import { clearDynamicLists, decideCruiseControl } from "./classifier"

/**
 * Built-in Cruise Control plugin: registers permission module `cruise_control`
 * via the public `permission.registerModule` API.
 *
 * Disabled with other default plugins when `disableDefaultPlugins` is set.
 * Requires an EffectBridge so decide can use Config from the host fiber.
 *
 * Default classifier instructions are applied at decision time, never written
 * into the user's config: they would go stale on every update in a file the
 * user never edited, and improved defaults should ship with the code.
 *
 * Clears the per-prompt dynamic allow/deny lists on each new user message
 * (`chat.message`) so learned decisions do not leak across prompt turns.
 */
export function createCruiseControlPlugin(bridge: EffectBridge.Shape): Plugin {
  return async (input: PluginInput): Promise<Hooks> => {
    input.permission.registerModule({
      id: PermissionModuleSchema.CRUISE_CONTROL,
      decide: async (req) => {
        const result = await bridge.promise(
          decideCruiseControl({
            model: input.model,
            paths: input.paths,
            moduleID: PermissionModuleSchema.CRUISE_CONTROL,
            permission: req.permission,
            patterns: req.patterns,
            metadata: req.metadata,
            userPrompt: req.userPrompt,
            sessionContext: req.sessionContext,
            approvalPrompt: req.approvalPrompt,
            cacheScope: req.cacheScope,
          }),
        )
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
