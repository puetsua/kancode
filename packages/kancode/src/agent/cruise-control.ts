import path from "path"
import { Global } from "@kancode/core/global"
import { PermissionModule } from "@kancode/schema/permission-module"
import PROMPT from "./cruise-control-prompt.txt"

/** Builtin agent id `cruisecontrol` (display: CruiseControl). Distinct from classifier id `cruise_control`. */
export const AGENT_ID = "cruisecontrol" as const

export const AGENT_DESCRIPTION =
  "Autonomous execution agent. Careful tool use; tool permissions go through the cruise_control classifier."

export const AGENT_PROMPT = PROMPT

/**
 * V1 permission config for the CruiseControl agent. The agent stays host-side
 * even as the classifier moves to an external plugin: it is a static prompt plus
 * ruleset with no host coupling, and shipping it separately would mean an agent
 * whose every action routes to a module that may not be installed.
 */
export function cruiseControlPermissionConfig() {
  return {
    "*": PermissionModule.CRUISE_CONTROL,
    question: "allow" as const,
    plan_enter: "allow" as const,
  }
}

/**
 * Glob patterns for agent `external_directory` allow rules covering KanCode's own
 * app directories. Kept host-side: the agent ships with KanCode and must not
 * depend on the cruise-control plugin being installed.
 */
export function managedAppDirectoryGlobs(): string[] {
  return [Global.Path.config, Global.Path.data, Global.Path.cache, Global.Path.state, Global.Path.tmp].map((root) =>
    path.join(root, "*"),
  )
}
