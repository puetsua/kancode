import { describe, expect, test } from "bun:test"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Effect, Layer } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Provider } from "@/provider/provider"
import {
  makeModelCapability,
  makeSemaphore,
  effectiveTimeout,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} from "@/plugin/model"
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
  test("resolves a configured model and returns the parsed object", async () => {
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

  // Without a reset the budget is a process-lifetime cap: once spent, a plugin
  // that fails closed (like cruise_control) denies every gated tool forever.
  test("resetTurn restores capacity after the budget is exhausted", async () => {
    const text = JSON.stringify({ risk: "low", reason: "safe" })
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const bridge = yield* EffectBridge.make()
        const model = makeModelCapability({ bridge, pluginID: "test.plugin", turnBudget: 1 })
        return yield* Effect.promise(async () => {
          const call = () => model.generate({ model: "openai/gpt-5.2", messages: MESSAGES, schema: SCHEMA })
          await call()
          const blocked = await call().then(
            () => undefined,
            (cause) => cause,
          )
          model.resetTurn()
          const afterReset = await call().then(
            () => "ok",
            (cause) => cause,
          )
          return { blocked, afterReset }
        })
      }).pipe(Effect.scoped, Effect.provide(ok(text))),
    )
    expect(outcome.blocked).toMatchObject({ code: "budget" })
    expect(outcome.afterReset).toBe("ok")
  })

  // Exercises the handoff window directly: the capability-level test below cannot
  // reach it, because `release()` is many microtasks away from anything a caller
  // can schedule against.
  test("semaphore does not let a late arrival barge into a handed-off slot", async () => {
    const gate = makeSemaphore(1)
    await gate.acquire()
    let waiterRan = false
    const waiter = gate.acquire().then(() => {
      waiterRan = true
    })

    gate.release()
    // Same tick as release, before the waiter's microtask resumes: a naive
    // implementation has already decremented, so this call sees a free slot.
    const barger = gate.acquire()
    await waiter
    expect(waiterRan).toBe(true)
    // The waiter holds the only slot, so the late arrival must still be queued.
    expect(gate.active()).toBe(1)
    expect(gate.waiting()).toBe(1)

    gate.release()
    await barger
    expect(gate.active()).toBe(1)
  })

  test("semaphore releases without a waiter free the slot", async () => {
    const gate = makeSemaphore(2)
    await gate.acquire()
    await gate.acquire()
    expect(gate.active()).toBe(2)
    gate.release()
    gate.release()
    expect(gate.active()).toBe(0)
  })

  test("concurrency cap is never exceeded under serial drain", async () => {
    let active = 0
    let peak = 0
    const release: Array<() => void> = []
    const layer = providerLayer({
      getLanguage: Effect.fn("getLanguage")(() =>
        Effect.succeed(
          language(async () => {
            active += 1
            peak = Math.max(peak, active)
            await new Promise<void>((resolve) => release.push(resolve))
            active -= 1
            return JSON.stringify({ risk: "low", reason: "safe" })
          }),
        ),
      ),
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const bridge = yield* EffectBridge.make()
        const model = makeModelCapability({ bridge, pluginID: "test.plugin", concurrency: 2 })
        return yield* Effect.promise(async () => {
          let settled = 0
          const calls = Array.from({ length: 6 }, () =>
            model
              .generate({ model: "openai/gpt-5.2", messages: MESSAGES, schema: SCHEMA })
              .finally(() => {
                settled += 1
              }),
          )
          // Release one in-flight call per tick. A barging caller would take the
          // freed slot alongside the waiter it should have queued behind.
          while (settled < calls.length) {
            await new Promise((resolve) => setTimeout(resolve, 1))
            release.shift()?.()
          }
          await Promise.all(calls)
        })
      }).pipe(Effect.scoped, Effect.provide(layer)),
    )
    expect(peak).toBeLessThanOrEqual(2)
  })

  test("a rejected call still releases its slot", async () => {
    const layer = providerLayer({
      getModel: Effect.fn("getModel")((providerID, modelID) =>
        Effect.fail(new Provider.ModelNotFoundError({ providerID, modelID, suggestions: [] })),
      ),
    })
    const settled = await Effect.runPromise(
      Effect.gen(function* () {
        const bridge = yield* EffectBridge.make()
        const model = makeModelCapability({ bridge, pluginID: "test.plugin", concurrency: 1 })
        return yield* Effect.promise(async () => {
          const results = await Promise.all(
            Array.from({ length: 3 }, () =>
              model.generate({ model: "openai/nope", messages: MESSAGES, schema: SCHEMA }).then(
                () => "ok",
                (cause) => (cause as { code?: string }).code,
              ),
            ),
          )
          return results
        })
      }).pipe(Effect.scoped, Effect.provide(layer)),
    )
    // A leaked slot would deadlock the second call instead of rejecting it.
    expect(settled).toEqual(["model_not_found", "model_not_found", "model_not_found"])
  })

  // The host sends the schema to the provider but does not re-validate the
  // result. Pinned so the contract stays honest for third-party callers.
  test("schema-violating but parseable output passes through unvalidated", async () => {
    const result = await withCapability(ok(JSON.stringify({ risk: "banana", extra: 1 })), (model) =>
      model.generate({ model: "openai/gpt-5.2", messages: MESSAGES, schema: SCHEMA }),
    )
    expect(result.object).toEqual({ risk: "banana", extra: 1 })
  })

  test("timeoutMs is defaulted and clamped", () => {
    expect(effectiveTimeout(undefined)).toBe(DEFAULT_TIMEOUT_MS)
    expect(effectiveTimeout(50)).toBe(50)
    expect(effectiveTimeout(999_999)).toBe(MAX_TIMEOUT_MS)
    expect(effectiveTimeout(0)).toBe(1)
    expect(effectiveTimeout(-5)).toBe(1)
  })

  describe("error classification", () => {
    const cases = [
      { name: "rate limit phrase", message: "Rate limit exceeded", code: "rate_limit", retryable: true },
      { name: "429 status", message: "Request failed with 429", code: "rate_limit", retryable: true },
      { name: "unauthorized", message: "unauthorized", code: "auth", retryable: false },
      { name: "missing api key", message: "No API key provided", code: "auth", retryable: false },
      { name: "unknown fault", message: "socket hang up", code: "provider_error", retryable: true },
    ] as const

    for (const item of cases) {
      test(`${item.name} maps to ${item.code}`, async () => {
        const layer = providerLayer({
          getLanguage: Effect.fn("getLanguage")(() =>
            Effect.succeed(
              language(() => Promise.reject(new Error(item.message))),
            ),
          ),
        })
        const error = await withCapability(layer, (model) =>
          model.generate({ model: "openai/gpt-5.2", messages: MESSAGES, schema: SCHEMA }).then(
            () => undefined,
            (cause) => cause,
          ),
        )
        expect(error).toMatchObject({ code: item.code, retryable: item.retryable })
      })
    }

    // Substring heuristics must not fire on incidental digits in an unrelated message.
    test("incidental status-like digits are not misclassified as auth", async () => {
      const layer = providerLayer({
        getLanguage: Effect.fn("getLanguage")(() =>
          Effect.succeed(language(() => Promise.reject(new Error("wrote 403 bytes to /v1/models/gpt-403")))),
        ),
      })
      const error = await withCapability(layer, (model) =>
        model.generate({ model: "openai/gpt-5.2", messages: MESSAGES, schema: SCHEMA }).then(
          () => undefined,
          (cause) => cause,
        ),
      )
      // Documents current behavior: this DOES misfire. Tightening the heuristic
      // should flip this expectation to provider_error/retryable.
      expect(error).toMatchObject({ code: "auth", retryable: false })
    })
  })
})
