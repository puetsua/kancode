import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@kancode/core/cross-spawn-spawner"
import { Global } from "@kancode/core/global"
import { Npm } from "@kancode/core/npm"
import path from "path"
import { pathToFileURL } from "url"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"

import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { ProviderV2 } from "@kancode/core/provider"
import { ModelV2 } from "@kancode/core/model"
import { AppNodeBuilder } from "@kancode/core/effect/app-node-builder"
import { LayerNode } from "@kancode/core/effect/layer-node"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)
const systemHook = "experimental.chat.system.transform"

const PLUGIN_ID = "test.plugin-input"

/** Reports `input.paths` back through a system-transform hook so the test can inspect it. */
const REPORTER = [
  "export default {",
  `  id: ${JSON.stringify(PLUGIN_ID)},`,
  "  server: async (input) => ({",
  `    ${JSON.stringify(systemHook)}: (_i, output) => {`,
  "      output.system.push(JSON.stringify(input.paths))",
  "    },",
  "  }),",
  "}",
  "",
].join("\n")

function withProject<A, E, R>(source: string, config: Record<string, unknown>, self: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const test = yield* TestInstance
    const file = path.join(test.directory, "plugin.ts")
    yield* Effect.all(
      [
        Effect.promise(() => Bun.write(file, source)),
        Effect.promise(() =>
          Bun.write(
            path.join(test.directory, "kancode.json"),
            JSON.stringify(
              {
                $schema: "https://raw.githubusercontent.com/puetsua/kancode/main/schemas/kancode.schema.json",
                plugin: [pathToFileURL(file).href],
                ...config,
              },
              null,
              2,
            ),
          ),
        ),
      ],
      { discard: true, concurrency: 2 },
    )
    return yield* self
  })
}

const triggerSystemTransform = Effect.fn("PluginInputTest.triggerSystemTransform")(function* () {
  const plugin = yield* Plugin.Service
  const out = { system: [] as string[] }
  yield* plugin.trigger(
    systemHook,
    { model: { providerID: ProviderV2.ID.anthropic, modelID: ModelV2.ID.make("claude-sonnet-4-6") } },
    out,
  )
  return out.system
})

describe("PluginInput.paths", () => {
  it.instance("reaches an externally loaded plugin with resolved app roots", () =>
    withProject(
      REPORTER,
      {},
      Effect.gen(function* () {
        // Global has no test override, so make() resolves the same roots the Plugin layer sees.
        const global = Global.make()
        const [reported] = yield* triggerSystemTransform()
        expect(reported).toBeDefined()
        expect(JSON.parse(reported!)).toEqual({
          config: global.config,
          data: global.data,
          cache: global.cache,
          state: global.state,
          tmp: global.tmp,
        })
      }),
    ),
  )
})

describe("PluginInput.model", () => {
  // Proves the capability is actually handed to an externally loaded plugin,
  // not just present on the type. Provider is absent here, so a real call
  // surfaces the `unavailable` code rather than crashing plugin load.
  it.instance("is callable from an externally loaded plugin", () =>
    withProject(
      [
        "export default {",
        `  id: ${JSON.stringify(PLUGIN_ID)},`,
        "  server: async (input) => ({",
        `    ${JSON.stringify(systemHook)}: async (_i, output) => {`,
        "      output.system.push(typeof input.model.generate)",
        "      try {",
        "        await input.model.generate({ model: 'openai/gpt-5.2', messages: [], schema: {} })",
        "        output.system.push('resolved')",
        "      } catch (error) {",
        "        output.system.push(`${error.name}:${error.code}`)",
        "      }",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
      {},
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["function", "ModelGenerateError:unavailable"])
      }),
    ),
  )
})

describe("model call budget", () => {
  beforeEach(() => {
    process.env.KANCODE_PLUGIN_MODEL_TURN_BUDGET = "1"
  })
  afterEach(() => {
    delete process.env.KANCODE_PLUGIN_MODEL_TURN_BUDGET
  })

  // The unit test in model.test.ts proves resetTurn works; this proves it is
  // actually wired. Without it the per-turn budget is a process-lifetime budget
  // and a fail-closed plugin denies every gated tool for the rest of the session.
  it.instance("is reset on each new user message", () =>
    withProject(
      [
        "let calls = 0",
        "export default {",
        `  id: ${JSON.stringify(PLUGIN_ID)},`,
        "  server: async (input) => ({",
        `    "chat.message": async () => {`,
        "      calls += 1",
        "      try {",
        "        await input.model.generate({ model: 'openai/gpt-5.2', messages: [], schema: {} })",
        "      } catch (error) {",
        "        globalThis.__budgetCodes = (globalThis.__budgetCodes ?? []).concat(error.code)",
        "      }",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
      {},
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        // Budget of one call per turn, so an unreset counter is immediately visible.
        // Provider is absent here, so a permitted call fails with `unavailable`;
        // a refused one fails with `budget`.
        yield* plugin.trigger("chat.message", { sessionID: "ses_a" } as never, {} as never)
        yield* plugin.trigger("chat.message", { sessionID: "ses_a" } as never, {} as never)
        const codes = (globalThis as { __budgetCodes?: string[] }).__budgetCodes ?? []
        delete (globalThis as { __budgetCodes?: string[] }).__budgetCodes
        expect(codes).toEqual(["unavailable", "unavailable"])
      }),
    ),
  )
})

describe("plugin_enabled", () => {
  it.instance("skips a plugin explicitly disabled by id", () =>
    withProject(
      REPORTER,
      { plugin_enabled: { [PLUGIN_ID]: false } },
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual([])
      }),
    ),
  )

  it.instance("loads a plugin explicitly enabled by id", () =>
    withProject(
      REPORTER,
      { plugin_enabled: { [PLUGIN_ID]: true } },
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toHaveLength(1)
      }),
    ),
  )

  it.instance("ignores an override naming a different plugin", () =>
    withProject(
      REPORTER,
      { plugin_enabled: { "some.other.plugin": false } },
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toHaveLength(1)
      }),
    ),
  )

  // Legacy plugins export a bare function with no id, so they can only be
  // addressed by the spec string the user wrote in `plugin`.
  const LEGACY = [
    "export const hook = async () => ({",
    `  ${JSON.stringify(systemHook)}: (_i, output) => {`,
    '    output.system.push("legacy")',
    "  },",
    "})",
    "",
  ].join("\n")

  it.instance("loads a legacy bare-function plugin", () =>
    withProject(
      LEGACY,
      {},
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["legacy"])
      }),
    ),
  )

  it.instance("disables a legacy plugin by its spec string", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "plugin.ts")
      const spec = pathToFileURL(file).href
      yield* Effect.promise(() => Bun.write(file, LEGACY))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(test.directory, "kancode.json"),
          JSON.stringify({ plugin: [spec], plugin_enabled: { [spec]: false } }, null, 2),
        ),
      )
      expect(yield* triggerSystemTransform()).toEqual([])
    }),
  )
})
