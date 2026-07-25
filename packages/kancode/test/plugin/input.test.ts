import { describe, expect } from "bun:test"
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
})
