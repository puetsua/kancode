import { describe, expect, test, beforeEach } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import { Global } from "@kancode/core/global"
import { PermissionModule as PermissionModuleSchema } from "@kancode/schema/permission-module"
import { Permission } from "../../src/permission"
import { PermissionModule } from "../../src/permission/module"
import {
  cruiseControlMetadata,
  cruiseControlMetadataFromDenied,
  cruiseControlSessionView,
  cruiseControlUserPrompt,
  currentUserPrompt,
  formatCruiseControlReview,
} from "../../src/session/tools"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@kancode/core/cross-spawn-spawner"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { testEffect } from "../lib/effect"
import { MessageID, SessionID } from "../../src/session/schema"
import { AppNodeBuilder } from "@kancode/core/effect/app-node-builder"
import { LayerNode } from "@kancode/core/effect/layer-node"
import { ConfigPermissionV1 } from "@kancode/core/v1/config/permission"
import { ConfigMigrateV1 } from "@kancode/core/v1/config/migrate"
import { PermissionV1 } from "@kancode/core/v1/permission"
import { Config } from "../../src/config/config"
import { Provider } from "../../src/provider/provider"
import { TestConfig } from "../fixture/config"
import { runPluginPermissionModule } from "../../src/plugin"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

/** Classifier app roots. Real Global paths so managed-directory rails behave as in production. */
const TEST_PATHS = {
  config: Global.Path.config,
  data: Global.Path.data,
  cache: Global.Path.cache,
  state: Global.Path.state,
  tmp: Global.Path.tmp,
}

function lowRisk(reason: string) {
  return { risk: "low" as const, intent: "medium" as const, reason }
}

function highRiskLowIntent(reason: string) {
  return { risk: "high" as const, intent: "low" as const, reason }
}

function reviewed(
  decision: "allow" | "deny",
  risk: "high" | "medium" | "low",
  intent: "high" | "medium" | "low",
  reason: string,
) {
  return { decision, reason, review: { risk, intent, reason } }
}

function stubModules(
  decide: (
    input: PermissionModule.DecideInput,
  ) => Effect.Effect<PermissionModule.Decision | PermissionModule.DecideResult>,
) {
  return Layer.succeed(
    PermissionModule.Service,
    PermissionModule.Service.of({
      decide: (input) => decide(input).pipe(Effect.map(PermissionModule.normalizeDecide)),
      register: () => Effect.succeed(() => {}),
      registerSync: () => () => {},
      has: () => true,
    }),
  )
}

describe("permission modules", () => {
  test("fromConfig accepts cruise_control module action", () => {
    const result = Permission.fromConfig({ bash: "cruise_control" })
    expect(result).toEqual([{ permission: "bash", pattern: "*", action: "cruise_control" }])
  })

  test("migrate maps module action to ask + module", () => {
    const migrated = ConfigMigrateV1.migrate({
      permission: { bash: "cruise_control", edit: "ask" },
      permission_modules: {
        cruise_control: { model: "opencode/deepseek-v4-flash" },
      },
    })
    expect(migrated.permission_modules).toEqual({
      cruise_control: { model: "opencode/deepseek-v4-flash" },
    })
    expect(migrated.permissions).toContainEqual({
      action: "bash",
      resource: "*",
      effect: "ask",
      module: "cruise_control",
    })
    expect(migrated.permissions).toContainEqual({
      action: "edit",
      resource: "*",
      effect: "ask",
    })
  })

  test("isStaticAction rejects module ids", () => {
    expect(ConfigPermissionV1.isStaticAction("ask")).toBe(true)
    expect(ConfigPermissionV1.isStaticAction("cruise_control")).toBe(false)
  })

  test("registry isolates same module id by workspace scope and unregisters independently", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const modules = yield* PermissionModule.Service
        const unregisterA = modules.registerSync({
          id: "scoped",
          scope: "workspace-a",
          decide: () => Effect.succeed({ decision: "deny", reason: "workspace a" }),
        })
        const unregisterB = modules.registerSync({
          id: "scoped",
          scope: "workspace-b",
          decide: () => Effect.succeed({ decision: "allow", reason: "workspace b" }),
        })
        const input = { moduleID: "scoped", permission: "bash", patterns: ["ls"], metadata: {} }

        expect(yield* modules.decide({ ...input, scope: "workspace-a" })).toEqual({
          decision: "deny",
          reason: "workspace a",
        })
        expect(yield* modules.decide({ ...input, scope: "workspace-b" })).toEqual({
          decision: "allow",
          reason: "workspace b",
        })

        unregisterA()
        expect(yield* modules.decide({ ...input, scope: "workspace-a" })).toEqual({
          decision: "ask",
          reason: 'Permission module "scoped" is not available; approve manually.',
        })
        expect(yield* modules.decide({ ...input, scope: "workspace-b" })).toEqual({
          decision: "allow",
          reason: "workspace b",
        })
        unregisterB()
      }).pipe(Effect.provide(PermissionModule.layer)),
    )
  })

  test("unregistered module asks and names the module", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const modules = yield* PermissionModule.Service
        expect(
          yield* modules.decide({ moduleID: "not_a_real_module", permission: "bash", patterns: ["ls"], metadata: {} }),
        ).toEqual({
          decision: "ask",
          reason: 'Permission module "not_a_real_module" is not available; approve manually.',
        })
      }).pipe(Effect.provide(PermissionModule.layer)),
    )
  })

  test("registered module that throws still fails closed to deny", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const modules = yield* PermissionModule.Service
        modules.registerSync({
          id: "boom",
          decide: () => Effect.succeed("nonsense" as never),
        })
        expect(
          yield* modules.decide({ moduleID: "boom", permission: "bash", patterns: ["ls"], metadata: {} }),
        ).toEqual({ decision: "deny" })
      }).pipe(Effect.provide(PermissionModule.layer)),
    )
  })

  test("external plugin invalid and rejected decisions fail closed", async () => {
    const input = { permission: "bash", patterns: ["ls"], metadata: {} }
    expect(
      await Effect.runPromise(
        runPluginPermissionModule({ id: "invalid", decide: async () => ({ decision: "invalid" }) as never }, input),
      ),
    ).toEqual({
      decision: "deny",
      reason: "Permission module returned an invalid decision; denied",
    })
    expect(
      await Effect.runPromise(
        runPluginPermissionModule(
          {
            id: "rejected",
            decide: async () => {
              throw new Error("boom")
            },
          },
          input,
        ),
      ),
    ).toEqual({ decision: "deny", reason: "Permission module failed; denied" })
  })
})

const allowEnv = AppNodeBuilder.build(
  LayerNode.group([
    Permission.node,
    PermissionModule.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
    InstanceStore.node,
  ]),
  [
    [InstanceStore.bootstrapNode, noopBootstrap],
    [PermissionModule.node, stubModules(() => Effect.succeed("allow"))],
  ],
)

const denyEnv = AppNodeBuilder.build(
  LayerNode.group([
    Permission.node,
    PermissionModule.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
    InstanceStore.node,
  ]),
  [
    [InstanceStore.bootstrapNode, noopBootstrap],
    [PermissionModule.node, stubModules(() => Effect.succeed("deny"))],
  ],
)

const askEnv = AppNodeBuilder.build(
  LayerNode.group([
    Permission.node,
    PermissionModule.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
    InstanceStore.node,
  ]),
  [
    [InstanceStore.bootstrapNode, noopBootstrap],
    [PermissionModule.node, stubModules(() => Effect.succeed("ask"))],
  ],
)

const itAllow = testEffect(allowEnv)
const itDeny = testEffect(denyEnv)
const itAsk = testEffect(askEnv)

itAllow.instance("cruise_control allow skips human ask", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    yield* permission.ask({
      sessionID: SessionID.make("ses_module_allow"),
      permission: "bash",
      patterns: ["ls"],
      metadata: {},
      always: ["ls"],
      ruleset: Permission.fromConfig({ bash: PermissionModuleSchema.CRUISE_CONTROL }),
      tool: { messageID: MessageID.make("msg_module_allow"), callID: "call_1" },
    })
    expect(yield* permission.list()).toEqual([])
  }),
)

itDeny.instance("cruise_control deny fails closed", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const result = yield* permission
      .ask({
        sessionID: SessionID.make("ses_module_deny"),
        permission: "bash",
        patterns: ["rm -rf /"],
        metadata: {},
        always: [],
        ruleset: Permission.fromConfig({ bash: PermissionModuleSchema.CRUISE_CONTROL }),
      })
      .pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
  }),
)

itAsk.instance("generic permission module ask publishes pending request", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* permission
      .ask({
        sessionID: SessionID.make("ses_generic_module_ask"),
        permission: "bash",
        patterns: ["npm install"],
        metadata: {},
        always: ["npm install"],
        ruleset: Permission.fromConfig({ bash: "custom_module" }),
      })
      .pipe(Effect.forkChild)

    const pending = yield* Effect.gen(function* () {
      while (true) {
        const list = yield* permission.list()
        if (list.length === 1) return list
        yield* Effect.sleep("10 millis")
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "1 second",
        orElse: () => Effect.fail(new Error("timed out waiting for pending ask")),
      }),
    )

    expect(pending[0]?.permission).toBe("bash")
    yield* permission.reply({ requestID: pending[0]!.id, reply: "once" })
    yield* Fiber.join(fiber)
  }),
)

// Real (empty) registry: nothing registers cruise_control, mirroring a first run,
// an offline install failure, or a user who removed the plugin.
const unregisteredEnv = AppNodeBuilder.build(
  LayerNode.group([
    Permission.node,
    PermissionModule.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
    InstanceStore.node,
  ]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)

const itUnregistered = testEffect(unregisteredEnv)

itUnregistered.instance("unregistered cruise_control asks instead of denying", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* permission
      .ask({
        sessionID: SessionID.make("ses_module_missing"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: Permission.fromConfig({ bash: PermissionModuleSchema.CRUISE_CONTROL }),
      })
      .pipe(Effect.forkChild)

    const pending = yield* Effect.gen(function* () {
      while (true) {
        const list = yield* permission.list()
        if (list.length === 1) return list
        yield* Effect.sleep("10 millis")
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "1 second",
        orElse: () => Effect.fail(new Error("timed out waiting for pending ask")),
      }),
    )

    expect(pending[0]?.metadata).toMatchObject({
      reason: 'Permission module "cruise_control" is not available; approve manually.',
    })
    yield* permission.reply({ requestID: pending[0]!.id, reply: "once" })
    yield* Fiber.join(fiber)
  }),
)

itUnregistered.instance("unrestricted mode still bypasses an unregistered module", () =>
  Effect.gen(function* () {
    process.env.KANCODE_UNRESTRICTED_PERMISSION = "1"
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        delete process.env.KANCODE_UNRESTRICTED_PERMISSION
      }),
    )
    const permission = yield* Permission.Service
    yield* permission.ask({
      sessionID: SessionID.make("ses_module_unrestricted"),
      permission: "bash",
      patterns: ["ls"],
      metadata: {},
      always: ["ls"],
      ruleset: Permission.fromConfig({ bash: PermissionModuleSchema.CRUISE_CONTROL }),
    })
    expect(yield* permission.list()).toEqual([])
  }),
)

const askReasonEnv = AppNodeBuilder.build(
  LayerNode.group([
    Permission.node,
    PermissionModule.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
    InstanceStore.node,
  ]),
  [
    [InstanceStore.bootstrapNode, noopBootstrap],
    [
      PermissionModule.node,
      stubModules(() => Effect.succeed({ decision: "ask" as const, reason: "network install needs review" })),
    ],
  ],
)

const itAskReason = testEffect(askReasonEnv)

itAskReason.instance("generic permission module ask attaches reason to metadata", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* permission
      .ask({
        sessionID: SessionID.make("ses_generic_module_ask_reason"),
        permission: "bash",
        patterns: ["npm install"],
        metadata: {},
        always: ["npm install"],
        ruleset: Permission.fromConfig({ bash: "custom_module" }),
      })
      .pipe(Effect.forkChild)

    const pending = yield* Effect.gen(function* () {
      while (true) {
        const list = yield* permission.list()
        if (list.length === 1) return list
        yield* Effect.sleep("10 millis")
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "1 second",
        orElse: () => Effect.fail(new Error("timed out waiting for pending ask")),
      }),
    )

    expect(pending[0]?.metadata?.reason).toBe("network install needs review")
    yield* permission.reply({ requestID: pending[0]!.id, reply: "once" })
    yield* Fiber.join(fiber)
  }),
)

const allowReasonEnv = AppNodeBuilder.build(
  LayerNode.group([
    Permission.node,
    PermissionModule.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
    InstanceStore.node,
  ]),
  [
    [InstanceStore.bootstrapNode, noopBootstrap],
    [
      PermissionModule.node,
      stubModules(() =>
        Effect.succeed({
          decision: "allow" as const,
          reason: "safe read-only command",
          metadata: { risk: "low", intent: "medium", reason: "safe read-only command" },
        }),
      ),
    ],
  ],
)

const itAllowReason = testEffect(allowReasonEnv)

itAllowReason.instance("cruise_control allow returns conclusion", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const result = yield* permission.ask({
      sessionID: SessionID.make("ses_module_allow_reason"),
      permission: "bash",
      patterns: ["ls"],
      metadata: {},
      always: ["ls"],
      ruleset: Permission.fromConfig({ bash: PermissionModuleSchema.CRUISE_CONTROL }),
      tool: { messageID: MessageID.make("msg_module_allow_reason"), callID: "call_allow_reason" },
    })
    expect(result.conclusion).toBe("safe read-only command")
    expect(result.cruiseControlReview).toEqual({
      risk: "low",
      intent: "medium",
      reason: "safe read-only command",
    })
    expect(formatCruiseControlReview(result.cruiseControlReview!)).toBe(
      "Risk: low · Intent: medium — safe read-only command",
    )
    expect(cruiseControlMetadata(result)).toEqual({
      cruise_control: "Risk: low · Intent: medium — safe read-only command",
      cruise_control_review: {
        risk: "low",
        intent: "medium",
        reason: "safe read-only command",
      },
    })
    expect(yield* permission.list()).toEqual([])
  }),
)

itAllowReason.instance("third-party module review is recognized by shape, not module id", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const result = yield* permission.ask({
      sessionID: SessionID.make("ses_third_party_review"),
      permission: "bash",
      patterns: ["ls"],
      metadata: {},
      always: ["ls"],
      ruleset: Permission.fromConfig({ bash: "puetsua_permit" }),
      tool: { messageID: MessageID.make("msg_third_party_review"), callID: "call_third_party" },
    })
    expect(result.cruiseControlReview).toEqual({
      risk: "low",
      intent: "medium",
      reason: "safe read-only command",
    })
    expect(cruiseControlMetadata(result)).toEqual({
      cruise_control: "Risk: low · Intent: medium — safe read-only command",
      cruise_control_review: { risk: "low", intent: "medium", reason: "safe read-only command" },
    })
  }),
)

const denyShapelessEnv = AppNodeBuilder.build(
  LayerNode.group([
    Permission.node,
    PermissionModule.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
    InstanceStore.node,
  ]),
  [
    [InstanceStore.bootstrapNode, noopBootstrap],
    [PermissionModule.node, stubModules(() => Effect.succeed({ decision: "deny" as const }))],
  ],
)

testEffect(denyShapelessEnv).instance("module deny without a reason names the module", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const result = yield* permission
      .ask({
        sessionID: SessionID.make("ses_module_deny_bare"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: Permission.fromConfig({ bash: "puetsua_permit" }),
      })
      .pipe(Effect.flip)
    expect(result).toBeInstanceOf(PermissionV1.DeniedError)
    expect((result as PermissionV1.DeniedError).reason).toBe('Permission module "puetsua_permit" denied the action')
    expect((result as PermissionV1.DeniedError).cruiseControlReview).toBeUndefined()
    // The model sees `.message`. A module denial reports its semantic cause and
    // deliberately does not fall through to DeniedError's ruleset dump.
    const message = (result as PermissionV1.DeniedError).message
    expect(message).toBe('Permission module "puetsua_permit" denied the action')
    expect(message).not.toContain("Relevant rules")
  }),
)

// Static denies carry no reason, so they keep the ruleset the model can adapt to.
testEffect(denyShapelessEnv).instance("static deny still reports the blocking ruleset", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const result = yield* permission
      .ask({
        sessionID: SessionID.make("ses_static_deny"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: Permission.fromConfig({ bash: "deny" }),
      })
      .pipe(Effect.flip)
    expect((result as PermissionV1.DeniedError).reason).toBeUndefined()
    expect((result as PermissionV1.DeniedError).message).toContain("Relevant rules")
  }),
)

const denyReasonEnv = AppNodeBuilder.build(
  LayerNode.group([
    Permission.node,
    PermissionModule.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
    InstanceStore.node,
  ]),
  [
    [InstanceStore.bootstrapNode, noopBootstrap],
    [
      PermissionModule.node,
      stubModules(() =>
        Effect.succeed({ decision: "deny" as const, reason: "Recursive force delete (rm -rf) is blocked" }),
      ),
    ],
  ],
)

const itDenyReason = testEffect(denyReasonEnv)

itDenyReason.instance("cruise_control deny surfaces reason on DeniedError", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const blocked = yield* permission
      .ask({
        sessionID: SessionID.make("ses_module_deny_reason"),
        permission: "bash",
        patterns: ["rm -rf /"],
        metadata: {},
        always: [],
        ruleset: Permission.fromConfig({ bash: PermissionModuleSchema.CRUISE_CONTROL }),
      })
      .pipe(Effect.flip)
    expect(blocked).toBeInstanceOf(PermissionV1.DeniedError)
    if (!(blocked instanceof PermissionV1.DeniedError)) return
    expect(blocked.message).toBe("Recursive force delete (rm -rf) is blocked")
    expect(blocked.cruiseControlReview).toBeUndefined()
  }),
)

const denyReviewEnv = AppNodeBuilder.build(
  LayerNode.group([
    Permission.node,
    PermissionModule.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
    InstanceStore.node,
  ]),
  [
    [InstanceStore.bootstrapNode, noopBootstrap],
    [
      PermissionModule.node,
      stubModules(() =>
        Effect.succeed({
          decision: "deny" as const,
          reason: "Destructive action is not supported by the prompt.",
          metadata: {
            risk: "high",
            intent: "low",
            reason: "Destructive action is not supported by the prompt.",
          },
        }),
      ),
    ],
  ],
)

const itDenyReview = testEffect(denyReviewEnv)

itDenyReview.instance("cruise_control deny with assessment formats levels on DeniedError", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const blocked = yield* permission
      .ask({
        sessionID: SessionID.make("ses_module_deny_review"),
        permission: "bash",
        patterns: ["rm important.txt"],
        metadata: {},
        always: [],
        ruleset: Permission.fromConfig({ bash: PermissionModuleSchema.CRUISE_CONTROL }),
      })
      .pipe(Effect.flip)
    expect(blocked).toBeInstanceOf(PermissionV1.DeniedError)
    if (!(blocked instanceof PermissionV1.DeniedError)) return
    expect(blocked.message).toBe(
      "Risk: high · Intent: low — Destructive action is not supported by the prompt.",
    )
    expect(blocked.cruiseControlReview).toEqual({
      risk: "high",
      intent: "low",
      reason: "Destructive action is not supported by the prompt.",
    })
    expect(cruiseControlMetadataFromDenied(blocked)).toEqual({
      cruise_control: "Risk: high · Intent: low — Destructive action is not supported by the prompt.",
      cruise_control_review: {
        risk: "high",
        intent: "low",
        reason: "Destructive action is not supported by the prompt.",
      },
    })
  }),
)

let forwardedUserPrompt: string | undefined
let forwardedSessionContext: readonly unknown[] | undefined
let forwardedApprovalPrompt: string | undefined
let forwardedScope: string | undefined
let forwardedCacheScope: string | undefined
const promptContextEnv = AppNodeBuilder.build(
  LayerNode.group([
    Permission.node,
    PermissionModule.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
    InstanceStore.node,
  ]),
  [
    [InstanceStore.bootstrapNode, noopBootstrap],
    [
      PermissionModule.node,
      stubModules((input) =>
        Effect.sync(() => {
          forwardedUserPrompt = input.userPrompt
          forwardedSessionContext = input.sessionContext
          forwardedApprovalPrompt = input.approvalPrompt
          forwardedScope = input.scope
          forwardedCacheScope = input.cacheScope
          return "allow" as const
        }),
      ),
    ],
  ],
)

const itPromptContext = testEffect(promptContextEnv)

itPromptContext.instance("permission forwards current user prompt to modules", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    yield* permission.ask({
      sessionID: SessionID.make("ses_module_prompt"),
      permission: "bash",
      patterns: ["deploy staging"],
      metadata: {},
      always: [],
      ruleset: Permission.fromConfig({ bash: PermissionModuleSchema.CRUISE_CONTROL }),
      userPrompt: "Deploy the current build to staging.",
      sessionContext: [
        { type: "user", text: "Deploy the current build to staging." },
        { type: "tool_call", tool: "bash", input: { command: "npm run build" } },
      ],
      approvalPrompt: "Deploy the current build to staging.",
      cacheScope: "workspace\0session\0prompt",
    })
    expect(forwardedUserPrompt).toBe("Deploy the current build to staging.")
    expect(forwardedSessionContext).toEqual([
      { type: "user", text: "Deploy the current build to staging." },
      { type: "tool_call", tool: "bash", input: { command: "npm run build" } },
    ])
    expect(forwardedApprovalPrompt).toBe("Deploy the current build to staging.")
    expect(forwardedScope).toBeTruthy()
    expect(forwardedCacheScope).toBe("workspace\0session\0prompt")
  }),
)


describe("host-side classifier context", () => {
  describe("preserveModuleReview", () => {
    const review = { risk: "low", intent: "medium", reason: "safe" }

    test("keeps both review keys across tool completion", () => {
      expect(
        Permission.preserveModuleReview({ cruise_control: "Risk: low", cruise_control_review: review, other: 1 }),
      ).toEqual({ cruise_control: "Risk: low", cruise_control_review: review })
    })

    test("keeps each key independently", () => {
      // Previously the detail was dropped unless a string summary was also present.
      expect(Permission.preserveModuleReview({ cruise_control_review: review })).toEqual({
        cruise_control_review: review,
      })
      expect(Permission.preserveModuleReview({ cruise_control: "Risk: low" })).toEqual({
        cruise_control: "Risk: low",
      })
    })

    test("passes malformed values through instead of dropping them", () => {
      // A broken third-party review should be visible, not silently discarded.
      expect(Permission.preserveModuleReview({ cruise_control: 42 })).toEqual({ cruise_control: 42 })
    })

    test("returns nothing when no review is present", () => {
      expect(Permission.preserveModuleReview({ title: "ls", output: "x" })).toEqual({})
    })

    test("a preserved review wins over a same-named tool metadata key", () => {
      const toolMetadata = { cruise_control: "from tool" }
      const preserved = Permission.preserveModuleReview({ cruise_control: "from module" })
      // Mirrors the spread order in SessionProcessor.completeToolCall.
      expect({ ...toolMetadata, ...preserved }).toEqual({ cruise_control: "from module" })
    })
  })

  test("currentUserPrompt keeps explicit current text and excludes synthetic context", () => {
    expect(
      currentUserPrompt([
        { info: { role: "user" }, parts: [{ type: "text", text: "old prompt" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "response" }] },
        {
          info: { role: "user" },
          parts: [
            { type: "text", text: "Explicitly update release.yml" },
            { type: "text", text: "host reminder", synthetic: true },
            { type: "text", text: "ignored", ignored: true },
          ],
        },
      ]),
    ).toBe("Explicitly update release.yml")
    expect(currentUserPrompt([])).toBeUndefined()
    expect(
      currentUserPrompt([{ info: { role: "user" }, parts: [{ type: "text", text: "host only", synthetic: true }] }]),
    ).toBeUndefined()
  })

  test("cruiseControlSessionView keeps user messages and tool call args only", () => {
    const view = cruiseControlSessionView([
      { info: { role: "user" }, parts: [{ type: "text", text: "inspect the repo" }] },
      {
        info: { role: "assistant" },
        parts: [
          { type: "reasoning", text: "I should check git status first." },
          { type: "text", text: "I'll run git status." },
          {
            type: "tool",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "git status" },
              output: "On branch main\nnothing to commit",
            },
          },
        ],
      },
      {
        info: { role: "user" },
        parts: [
          { type: "text", text: "ok, continue" },
          { type: "text", text: "host reminder", synthetic: true },
        ],
      },
      {
        info: { role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "read",
            state: {
              status: "running",
              input: { path: "README.md" },
            },
          },
        ],
      },
    ])
    expect(view).toEqual([
      { type: "user", text: "inspect the repo" },
      { type: "tool_call", tool: "bash", input: { command: "git status" } },
      { type: "user", text: "ok, continue" },
      { type: "tool_call", tool: "read", input: { path: "README.md" } },
    ])
    expect(JSON.stringify(view)).not.toContain("I should check")
    expect(JSON.stringify(view)).not.toContain("I'll run git status")
    expect(JSON.stringify(view)).not.toContain("nothing to commit")
  })

  test("cruiseControlUserPrompt enriches short affirmations after assistant permission asks", () => {
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "undo the last commit" }] },
      {
        info: { role: "assistant" },
        parts: [{ type: "text", text: "May I run `git reset --soft HEAD~1` to undo the last commit?" }],
      },
      { info: { role: "user" }, parts: [{ type: "text", text: "ok" }] },
    ]
    const prompt = cruiseControlUserPrompt(messages)
    expect(prompt).toContain("<conversation_context>")
    expect(prompt).toContain("May I run `git reset --soft HEAD~1`")
    expect(prompt).toContain("<current_user_reply>\nok\n</current_user_reply>")
    // The envelope is a wire contract: the host produces it, the cruise-control
    // plugin parses it. Assert the shape the plugin depends on.
    expect(prompt).toContain("<prior_assistant_reply>")
    expect(prompt).toContain("</conversation_context>")
    // Host-only enrichment must not appear in classifier-visible session projection.
    expect(JSON.stringify(cruiseControlSessionView(messages))).not.toContain("May I run")
  })
})
