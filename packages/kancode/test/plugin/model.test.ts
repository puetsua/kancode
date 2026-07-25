import { describe, expect, test } from "bun:test"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Effect, Layer } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Provider } from "@/provider/provider"
import { makeModelCapability } from "@/plugin/model"
import { ProviderTest } from "../fake/provider"

const SCHEMA = {
  type: "object",
  properties: { risk: { type: "string" }, reason: { type: "string" } },
  required: ["risk", "reason"],
  additionalProperties: false,
} as const

const MESSAGES = [{ role: "user" as const, content: "assess this" }]

/** Minimal LanguageModelV3 whose generated text and abort behavior the test controls. */
function language(handler: (options: { abortSignal?: AbortSignal }) => Promise<string>): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "openai",
    modelId: "gpt-5.2",
    supportedUrls: {},
    async doGenerate(options: { abortSignal?: AbortSignal }) {
      const text = await handler(options)
      return {
        content: [{ type: "text", text }],
        finishReason: "stop",
        // LanguageModelV3 reports usage nested; `ai` flattens it onto the result.
        usage: {
          inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 7, text: 7, reasoning: 0 },
        },
        warnings: [],
      }
    },
    async doStream() {
      throw new Error("doStream not used")
    },
  } as unknown as LanguageModelV3
}

/** Runs `body` with a bridge bound to `layer`, mirroring how PluginInput is built. */
function withCapability<A>(
  layer: Layer.Layer<never> | Layer.Layer<Provider.Service>,
  body: (model: ReturnType<typeof makeModelCapability>) => Promise<A>,
): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const bridge = yield* EffectBridge.make()
      const model = makeModelCapability({ bridge, pluginID: "test.plugin" })
      return yield* Effect.promise(() => body(model))
    }).pipe(Effect.scoped, Effect.provide(layer as Layer.Layer<never>)),
  )
}

function providerLayer(override: Parameters<typeof ProviderTest.fake>[0] = {}) {
  return ProviderTest.fake(override).layer
}

function ok(text: string) {
  return providerLayer({ getLanguage: Effect.fn("getLanguage")(() => Effect.succeed(language(async () => text))) })
}

describe("plugin model capability", () => {
  test("resolves a configured model and returns the validated object", async () => {
    const result = await withCapability(ok(JSON.stringify({ risk: "low", reason: "safe" })), (model) =>
      model.generate({ model: "openai/gpt-5.2", messages: MESSAGES, schema: SCHEMA }),
    )
    expect(result.object).toEqual({ risk: "low", reason: "safe" })
    expect(result.model).toEqual({ providerID: "openai", modelID: "gpt-5.2" })
    expect(result.usage).toEqual({ input: 11, output: 7, total: 18 })
  })

  test("result exposes no SDK handle or credential", async () => {
    const result = await withCapability(ok(JSON.stringify({ risk: "low", reason: "safe" })), (model) =>
      model.generate({ model: "openai/gpt-5.2", messages: MESSAGES, schema: SCHEMA }),
    )
    expect(Object.keys(result).sort()).toEqual(["model", "object", "usage"])
    expect(JSON.stringify(result)).not.toContain("apiKey")
  })

  test("missing model reference is not retryable", async () => {
    const error = await withCapability(ok("{}"), (model) =>
      model.generate({ model: "  ", messages: MESSAGES, schema: SCHEMA }).then(
        () => undefined,
        (cause) => cause,
      ),
    )
    expect(error).toMatchObject({ name: "ModelGenerateError", code: "model_unset", retryable: false })
  })

  test("unknown model is not retryable", async () => {
    const error = await withCapability(
      providerLayer({
        getModel: Effect.fn("getModel")((providerID, modelID) =>
          Effect.fail(new Provider.ModelNotFoundError({ providerID, modelID, suggestions: [] })),
        ),
      }),
      (model) =>
        model.generate({ model: "openai/nope", messages: MESSAGES, schema: SCHEMA }).then(
          () => undefined,
          (cause) => cause,
        ),
    )
    expect(error).toMatchObject({ name: "ModelGenerateError", code: "model_not_found", retryable: false })
  })

  test("unparseable output surfaces raw text for caller-side recovery", async () => {
    const error = await withCapability(ok("this is definitely not json"), (model) =>
      model.generate({ model: "openai/gpt-5.2", messages: MESSAGES, schema: SCHEMA }).then(
        () => undefined,
        (cause) => cause,
      ),
    )
    expect(error).toMatchObject({ name: "ModelGenerateError", code: "no_object", retryable: true })
    expect((error as { text?: string }).text).toContain("not json")
  })

  test("timeout aborts the underlying request rather than abandoning it", async () => {
    let aborted = false
    const layer = providerLayer({
      getLanguage: Effect.fn("getLanguage")(() =>
        Effect.succeed(
          language(
            (options) =>
              new Promise<string>((_resolve, reject) => {
                options.abortSignal?.addEventListener("abort", () => {
                  aborted = true
                  reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
                })
              }),
          ),
        ),
      ),
    })
    const error = await withCapability(layer, (model) =>
      model.generate({ model: "openai/gpt-5.2", messages: MESSAGES, schema: SCHEMA, timeoutMs: 50 }).then(
        () => undefined,
        (cause) => cause,
      ),
    )
    expect(error).toMatchObject({ name: "ModelGenerateError", code: "timeout", retryable: true })
    expect(aborted).toBe(true)
  })

  test("caller abort is reported as aborted, not timeout", async () => {
    const controller = new AbortController()
    const layer = providerLayer({
      getLanguage: Effect.fn("getLanguage")(() =>
        Effect.succeed(
          language(
            (options) =>
              new Promise<string>((_resolve, reject) => {
                options.abortSignal?.addEventListener("abort", () =>
                  reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
                )
                setTimeout(() => controller.abort(), 20)
              }),
          ),
        ),
      ),
    })
    const error = await withCapability(layer, (model) =>
      model
        .generate({
          model: "openai/gpt-5.2",
          messages: MESSAGES,
          schema: SCHEMA,
          timeoutMs: 5_000,
          abortSignal: controller.signal,
        })
        .then(
          () => undefined,
          (cause) => cause,
        ),
    )
    expect(error).toMatchObject({ name: "ModelGenerateError", code: "aborted", retryable: false })
  })

  // Guards the Provider -> Plugin dependency cycle: Provider.node depends on
  // Plugin.node, so the capability must resolve Provider per call, not at build.
  test("degrades to unavailable when the provider stack is absent", async () => {
    const error = await withCapability(Layer.empty as Layer.Layer<never>, (model) =>
      model.generate({ model: "openai/gpt-5.2", messages: MESSAGES, schema: SCHEMA }).then(
        () => undefined,
        (cause) => cause,
      ),
    )
    expect(error).toMatchObject({ name: "ModelGenerateError", code: "unavailable", retryable: false })
  })

  test("per-turn budget bounds a runaway plugin", async () => {
    const text = JSON.stringify({ risk: "low", reason: "safe" })
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const bridge = yield* EffectBridge.make()
        const model = makeModelCapability({ bridge, pluginID: "test.plugin", turnBudget: 2 })
        return yield* Effect.promise(async () => {
          const call = () => model.generate({ model: "openai/gpt-5.2", messages: MESSAGES, schema: SCHEMA })
          await call()
          await call()
          return await call().then(
            () => undefined,
            (cause) => cause,
          )
        })
      }).pipe(Effect.scoped, Effect.provide(ok(text))),
    )
    expect(error).toMatchObject({ name: "ModelGenerateError", code: "budget", retryable: false })
  })
})
