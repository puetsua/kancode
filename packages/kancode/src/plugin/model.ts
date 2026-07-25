import type {
  ModelCapability,
  ModelErrorCode,
  ModelGenerateInput,
  ModelGenerateResult,
  ModelMessage,
} from "@kancode/plugin"
import { generateObject, jsonSchema, NoObjectGeneratedError, type ModelMessage as SdkModelMessage } from "ai"
import { Effect, Option } from "effect"
import { ModelV2 } from "@kancode/core/model"
import { ProviderV2 } from "@kancode/core/provider"
import type { EffectBridge } from "@/effect/bridge"

/**
 * Provider is imported dynamically: `Provider.node` lists `Plugin.node` in its
 * deps, so a static import from the plugin package forms a module cycle and
 * `provider.ts` evaluates before `plugin/index.ts` finishes initializing.
 */
function loadProvider() {
  return import("@/provider/provider")
}

/** Tag of `Provider.ModelNotFoundError`, matched structurally to avoid importing Provider here. */
const MODEL_NOT_FOUND_TAG = "ProviderModelNotFoundError"

/** Applied when the caller omits `timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 30_000
/** Upper bound on `timeoutMs` so a plugin cannot pin a provider connection open indefinitely. */
export const MAX_TIMEOUT_MS = 120_000
/** Concurrent in-flight generate calls allowed per plugin. */
export const DEFAULT_CONCURRENCY = 4
/**
 * Calls one plugin may issue per turn. Sized to survive a burst of parallel
 * permission classifications while still bounding a runaway loop.
 */
export const DEFAULT_TURN_BUDGET = 200

class ModelError extends Error {
  override readonly name = "ModelGenerateError" as const
  readonly code: ModelErrorCode
  readonly retryable: boolean
  readonly text?: string

  constructor(code: ModelErrorCode, message: string, options?: { retryable?: boolean; text?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.retryable = options?.retryable ?? false
    this.text = options?.text
  }
}

/** Exported for host tests; plugins duck-type on `code` instead. */
export function modelError(
  code: ModelErrorCode,
  message: string,
  options?: { retryable?: boolean; text?: string; cause?: unknown },
) {
  return new ModelError(code, message, options)
}

/**
 * Maps a provider/SDK rejection onto the plugin-facing taxonomy. Distinguishing
 * permanent misconfiguration from transient faults lets callers stop retrying
 * things that can never succeed, such as a model id that does not exist.
 */
function classify(cause: unknown): ModelError {
  if (cause instanceof ModelError) return cause
  if (NoObjectGeneratedError.isInstance(cause)) {
    return new ModelError("no_object", "Model output did not match the requested schema", {
      retryable: true,
      text: cause.text,
      cause,
    })
  }
  if (typeof cause === "object" && cause !== null && "_tag" in cause && cause._tag === MODEL_NOT_FOUND_TAG) {
    const { providerID, modelID } = cause as { providerID?: string; modelID?: string }
    return new ModelError("model_not_found", `Model not found: ${providerID}/${modelID}`, { cause })
  }

  const message = cause instanceof Error ? cause.message : String(cause)
  if (cause instanceof Error && cause.name === "AbortError") {
    return new ModelError("aborted", "Model call aborted", { cause })
  }

  const lowered = message.toLowerCase()
  if (lowered.includes("rate limit") || lowered.includes("429") || lowered.includes("too many requests")) {
    return new ModelError("rate_limit", message, { retryable: true, cause })
  }
  if (
    lowered.includes("unauthorized") ||
    lowered.includes("401") ||
    lowered.includes("403") ||
    lowered.includes("api key") ||
    lowered.includes("credential")
  ) {
    return new ModelError("auth", message, { cause })
  }
  return new ModelError("provider_error", message, { retryable: true, cause })
}

function toSdkMessages(messages: readonly ModelMessage[]): SdkModelMessage[] {
  return messages.map((message) => ({ role: message.role, content: message.content }) as SdkModelMessage)
}

export interface ModelCapabilityOptions {
  bridge: EffectBridge.Shape
  /** Identifies the caller in usage logs and scopes its concurrency and budget. */
  pluginID: string
  concurrency?: number
  turnBudget?: number
}

/**
 * Builds the per-plugin `input.model` capability.
 *
 * `Provider.Service` is resolved inside each call, never at construction:
 * `Provider.node` depends on `Plugin.node`, so touching Provider while
 * `PluginInput` is being built would deadlock. Early-boot callers get
 * `unavailable` instead.
 */
export function makeModelCapability(options: ModelCapabilityOptions): ModelCapability & { resetTurn: () => void } {
  const limit = options.concurrency ?? DEFAULT_CONCURRENCY
  const budget = options.turnBudget ?? DEFAULT_TURN_BUDGET
  let active = 0
  let spent = 0
  const waiting: Array<() => void> = []

  async function acquire() {
    if (active < limit) {
      active += 1
      return
    }
    await new Promise<void>((resolve) => waiting.push(resolve))
    active += 1
  }

  function release() {
    active -= 1
    waiting.shift()?.()
  }

  async function generate<T>(input: ModelGenerateInput): Promise<ModelGenerateResult<T>> {
    const ref = input.model?.trim()
    if (!ref) throw new ModelError("model_unset", "No model reference supplied")
    if (spent >= budget) {
      throw new ModelError("budget", `Plugin ${options.pluginID} exceeded its per-turn model call budget (${budget})`)
    }
    spent += 1

    const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const started = Date.now()
    await acquire()
    try {
      return await options.bridge.promise(
        Effect.gen(function* () {
          const { Provider } = yield* Effect.promise(loadProvider)
          const service = yield* Effect.serviceOption(Provider.Service)
          if (Option.isNone(service)) {
            return yield* Effect.fail(
              new ModelError("unavailable", "Provider stack is not initialized yet; retry once startup completes"),
            )
          }
          const provider = service.value
          const [providerID, ...rest] = ref.split("/")
          const model = yield* provider.getModel(ProviderV2.ID.make(providerID), ModelV2.ID.make(rest.join("/")))
          const language = yield* provider.getLanguage(model)

          // Own abort controller so the timeout actually kills the request rather
          // than abandoning a promise that keeps the connection open.
          const controller = new AbortController()
          const onAbort = () => controller.abort()
          input.abortSignal?.addEventListener("abort", onAbort, { once: true })
          const timer = setTimeout(() => controller.abort(), timeoutMs)

          const result = yield* Effect.tryPromise({
            try: () =>
              generateObject({
                model: language,
                schema: jsonSchema(input.schema as Parameters<typeof jsonSchema>[0]),
                ...(input.schemaName ? { schemaName: input.schemaName } : {}),
                ...(input.schemaDescription ? { schemaDescription: input.schemaDescription } : {}),
                messages: toSdkMessages(input.messages),
                temperature: input.temperature ?? 0,
                ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
                abortSignal: controller.signal,
              }),
            catch: (cause) => {
              if (!controller.signal.aborted) return classify(cause)
              return input.abortSignal?.aborted
                ? new ModelError("aborted", "Model call aborted by caller", { cause })
                : new ModelError("timeout", `Model call exceeded ${timeoutMs}ms`, { retryable: true, cause })
            },
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                clearTimeout(timer)
                input.abortSignal?.removeEventListener("abort", onAbort)
              }),
            ),
          )

          const usage = {
            ...(result.usage?.inputTokens === undefined ? {} : { input: result.usage.inputTokens }),
            ...(result.usage?.outputTokens === undefined ? {} : { output: result.usage.outputTokens }),
            ...(result.usage?.totalTokens === undefined ? {} : { total: result.usage.totalTokens }),
          }

          yield* Effect.logInfo("plugin model call", {
            plugin: options.pluginID,
            model: `${model.providerID}/${model.id}`,
            latency_ms: Date.now() - started,
            ...usage,
          })

          return {
            object: result.object as T,
            model: { providerID: model.providerID, modelID: model.id },
            ...(Object.keys(usage).length > 0 ? { usage } : {}),
          } satisfies ModelGenerateResult<T>
        }),
      )
    } catch (cause) {
      throw classify(cause)
    } finally {
      release()
    }
  }

  return {
    generate,
    resetTurn: () => {
      spent = 0
    },
  }
}
