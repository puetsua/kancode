## 1. Ask-Fallback For Unregistered Modules

- [x] 1.1 In `packages/core/src/permission/module.ts` change the no-handler branch from `logError` + `{ decision: "deny" }` to `logWarning` + `{ decision: "ask", reason: 'Permission module "<id>" is not available; approve manually.' }`
- [x] 1.2 Delete the `cruise_control`-specific hard-deny branch in `packages/kancode/src/permission/index.ts` so the generic `needsAsk` + `metadata.warning` path below it handles a missing module service
- [x] 1.3 Add `packages/core` tests: unregistered module resolves to `ask` with a reason naming the module; a registered module that throws still denies
- [x] 1.4 Add `packages/kancode` permission tests: rule action `cruise_control` with nothing registered asks instead of raising `DeniedError`; `KANCODE_UNRESTRICTED_PERMISSION=1` still bypasses
- [x] 1.5 Run `bun typecheck` and `bun test` in `packages/core` and `packages/kancode`

## 2. Identity-Agnostic Review Metadata

- [ ] 2.1 Rename `CruiseControlReview` to `PermissionModuleReview` in `packages/kancode/src/permission/index.ts`, keeping the old name as an exported alias for existing callers
- [ ] 2.2 Replace the three `moduleID === CRUISE_CONTROL` branches with shape detection: any module metadata parsing as `{risk, intent, reason}` gets review formatting
- [ ] 2.3 Generalize `packages/kancode/src/session/processor.ts` to preserve a named set of module-review metadata keys instead of hardcoding `previous.cruise_control`
- [ ] 2.4 Add a test proving a non-`cruise_control` module returning `{risk,intent,reason}` gets the same rendering and preservation
- [ ] 2.5 Run `bun typecheck` and `bun test` in `packages/kancode`

## 3. Plugin Paths And Server-Side Enablement

- [ ] 3.1 Add `paths: { config, data, cache, state, tmp }` to `PluginInput` in `packages/plugin/src/index.ts`
- [ ] 3.2 Populate `paths` from the resolved global paths when constructing `PluginInput` in `packages/kancode/src/plugin/index.ts`
- [ ] 3.3 Add a server-side plugin enable/disable check before `applyPlugin`, mirroring the TUI's `plugin_enabled`, and extend the config schema for it
- [ ] 3.4 Add tests: a disabled plugin id is skipped and registers nothing; `paths` reaches an externally loaded plugin
- [ ] 3.5 Run `bun typecheck` and `bun test` in `packages/plugin` and `packages/kancode`

## 4. Plugin Model Capability

- [ ] 4.1 Declare `ModelMessage`, `ModelGenerateInput`, `ModelGenerateResult`, `ModelCapability`, and the typed error with `code`/`retryable` in `packages/plugin/src/index.ts` — structurally, with no `ai` or `effect` imports
- [ ] 4.2 Implement `packages/kancode/src/plugin/model.ts`: parse the model ref, resolve provider and language model host-side, call `generateObject` with the caller's raw JSON Schema, and map failures onto the error taxonomy
- [ ] 4.3 Enforce `timeoutMs` with a real abort signal so the underlying request dies, defaulting to 30s with a hard upper bound
- [ ] 4.4 Wire `model` into `PluginInput` over the existing `EffectBridge`, resolving `Provider.Service` via `Effect.serviceOption` **inside each call** so early-boot use yields `unavailable` instead of crashing on the Provider↔Plugin cycle
- [ ] 4.5 Add per-call structured logging with plugin id, resolved model, and token usage; enforce a per-plugin concurrency cap and per-turn call budget
- [ ] 4.6 Add `packages/kancode/test/plugin/model.test.ts` covering: successful resolution and validation; `model_not_found` non-retryable; `no_object` carrying raw text; `timeout` with a genuinely aborted request; `unavailable` before the Provider layer exists; and that the result exposes no SDK handle or credential
- [ ] 4.7 Add a fixture plugin under `packages/kancode/test/fixture/plugins/` that registers a permission module and calls `input.model.generate`, loaded through the real plugin loader, proving the capability reaches an external plugin
- [ ] 4.8 Refactor the in-tree classifier to obtain completions through `input.model.generate` instead of `Provider` + `generateObject`
- [ ] 4.9 Run `bun typecheck` and `bun test` in `packages/plugin` and `packages/kancode`

## 5. Make The Classifier Portable

- [ ] 5.1 Replace the generated classifier JSON Schema with a hand-written literal, dropping the `@/tool/json-schema` import
- [ ] 5.2 Replace `@kancode/core/global` usage with `input.paths` and inline the path-containment helper, dropping `@kancode/core/fs-util`
- [ ] 5.3 Read config through a short-TTL `client.config.get()` instead of `@/config/config`, preserving immediate effect when the model is changed at runtime
- [ ] 5.4 Duplicate `explicitApprovalIntent` and its affirmation helpers into the classifier, and document the `<conversation_context>` envelope as a host↔plugin contract in the permission-modules spec
- [ ] 5.5 Rewrite the classifier's Effect usage as plain async/await with a hand-rolled semaphore, removing the `effect` dependency entirely
- [ ] 5.6 Delete `ensureDefaultInstructions` and its tests so defaults are applied at classification time but never written to config
- [ ] 5.7 Change the unset-model outcome from deny to ask with a hint naming the model command, matching the shipped skill documentation
- [ ] 5.8 Add a check (test or lint rule) asserting the classifier directory imports only `@kancode/plugin` and node builtins
- [ ] 5.9 Run `bun typecheck` and `bun test` in `packages/kancode`

## 6. Extract And Publish The Plugin

- [ ] 6.1 Create the `@puetsua/kancode-cruise-control` repository and copy the portable classifier sources
- [ ] 6.2 Add separate `src/server.ts` and `src/tui.tsx` entrypoints — a single module must never export both `server` and `tui`
- [ ] 6.3 Move the `/cruise-control-model` command builder out of the TUI package into the plugin's TUI entry
- [ ] 6.4 Configure `package.json`: `exports["./server"]` with default options under `.config`, `exports["./tui"]`, `files` matching `exports`, compiled `dist`, the compatibility range, and `@kancode/plugin` as a peer dependency
- [ ] 6.5 Port the pure-logic tests (parsing, safety rails, instruction rendering, destructive rails, dynamic lists, managed-directory and session-scope allows, approval intent, classifier orchestration)
- [ ] 6.6 Verify manually against a local global config with the in-tree copy disabled: the module registers, classification works, and the command sets the model
- [ ] 6.7 Publish `0.1.0`

## 7. Seed By Default And Remove The In-Tree Copy

- [ ] 7.1 Delete the in-tree classifier sources, its lazy-load block in `packages/kancode/src/plugin/index.ts`, and the cruise command builder in the TUI package
- [ ] 7.2 Move the `cruisecontrol` agent prompt and permission defaults to `packages/kancode/src/agent/cruise-control.ts` so nothing remains under the old plugin directory
- [ ] 7.3 Implement `packages/kancode/src/plugin/default-plugins.ts` seeding into global config after the global merge and before plugin origins are computed, gated on default-plugins-enabled and non-pure mode, with installation on a detached fiber
- [ ] 7.4 Record seeding in a state-directory marker so a user-deleted entry is never resurrected, and honor the config-level disable from task 3.3 independently
- [ ] 7.5 Write the seeded entry unpinned, and leave any pre-existing user entry untouched
- [ ] 7.6 Downgrade install failures for seeded plugins from session errors to warnings so offline starts stay clean
- [ ] 7.7 Add a one-time upgrade notice explaining that Cruise Control is now an installing plugin
- [ ] 7.8 Add `packages/kancode/test/plugin/default-plugins.test.ts` covering: first run writes both configs preserving comments; second run no-ops; marker present with entry deleted does not re-add; disabled or pure mode seeds nothing; an existing pinned entry is left alone
- [ ] 7.9 Rewrite the affected sections of `openspec/specs/permission-cruise-control/spec.md` guidance and the `customize-opencode` skill, leaving a pointer to the plugin README
- [ ] 7.10 Verify end to end: fresh config dir seeds and installs, classification works, then with the package cache removed the next start degrades to asking rather than denying
- [ ] 7.11 Add a nightly CI job installing the published plugin and running one real classify against a cheap model
- [ ] 7.12 Run `bun typecheck` and `bun test` in `packages/core`, `packages/kancode`, `packages/plugin`, and `packages/tui`
