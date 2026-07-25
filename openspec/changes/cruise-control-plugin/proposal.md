## Why

Cruise Control is welded into three packages at three layers — the `cruise_control` classifier is a V1 built-in plugin (`packages/kancode/src/plugin/cruise-control/`), the `cruisecontrol` agent is a V2 core plugin, and `/cruise-control-model` is a TUI built-in. Every classifier tweak needs a full KanCode release, third parties cannot install it, and the core carries ~900 lines of policy that is not core.

It cannot be extracted today. `classifier.ts` reaches into `Provider`, `Config`, `ToolJsonSchema`, and `@kancode/core/*` internals to call `generateObject`. External plugins receive only `{ client, project, directory, worktree, permission, serverUrl, $ }`, there is no one-shot generation endpoint in the server HTTP API, and `ctx.aisdk` is a model-*construction* transform hook rather than a way to call a model. An external Cruise Control would be limited to its deterministic rails with no classification at all.

So the enabling work is to give plugins a first-class way to ask a model a question. Cruise Control is the forcing function that proves the plugin API is capable enough for real plugins.

## What Changes

- **New**: a generic `input.model.generate({ model, messages, schema, timeoutMs })` capability on the V1 `PluginInput`. The host resolves provider and credentials; the plugin never sees an API key. Plain JSON in, plain JSON out, so it can later be mirrored to an HTTP endpoint for out-of-process plugins without changing the plugin-facing contract.
- **New**: `input.paths` exposing the resolved config/data/cache/state/tmp roots, so plugins stop needing `@kancode/core/global` (which is `private: true` and unpublished).
- **New**: a server-side plugin enable/disable check, mirroring the TUI's existing `plugin_enabled`.
- **New**: first-run seeding of default plugins into global config, guarded by a state marker so a user-deleted entry is never resurrected.
- **BREAKING (behavior)**: an unregistered permission module now resolves to `ask` instead of `deny`. Errors from a *registered* module still fail closed to `deny`. This keeps KanCode fully usable offline and before the plugin finishes installing.
- **Changed**: permission-module review metadata is generalized off the hardcoded `cruise_control` id — any module returning `{risk, intent, reason}` gets the same TUI treatment.
- **Changed**: default classifier instructions are applied when unset but no longer *persisted* into the user's global config on first run.
- **Changed**: an unset classifier model resolves to `ask` rather than `deny`, matching what the shipped `customize-opencode` skill already documents.
- **Removed**: the in-tree Cruise Control classifier and its TUI command, once published as `@puetsua/kancode-cruise-control`. The `cruisecontrol` agent deliberately stays in-host.

**Non-goals**: no V2 `PluginContext` model domain (`packages/core` has no `Provider` service; adding one means inverting that dependency for zero consumers), no plugin marketplace or registry, no new HTTP generation endpoint, and no new GitHub Actions workflows beyond the existing release pipeline.

## Capabilities

### New Capabilities
- `plugin-model-capability`: how plugins obtain structured model completions from the host — the request/result contract, error taxonomy, timeout ownership, and the cost/abuse guardrails that come with granting model access.
- `plugin-default-install`: how KanCode seeds first-party plugins into global config on first run — idempotency, permanent opt-out, version floating, and offline degradation.

### Modified Capabilities
- `permission-modules`: unknown module lookup changes from fail-closed `deny` to `ask`; the fail-closed rule is narrowed to errors from registered modules. Module review metadata becomes id-agnostic.
- `permission-cruise-control`: Cruise Control becomes an externally installed plugin rather than a built-in; default instructions are no longer persisted to config; an unset model asks rather than denies.

## Impact

**Code**
- `packages/plugin/src/index.ts` — `PluginInput` gains `model` and `paths`; `ModelMessage` declared structurally rather than re-exported from `ai`.
- `packages/kancode/src/plugin/` — new `model.ts` and `default-plugins.ts`; `index.ts` wires both plus the enable/disable check; `cruise-control/` is eventually deleted.
- `packages/core/src/permission/module.ts` — unknown-module branch returns `ask`.
- `packages/kancode/src/permission/index.ts` — drop the `cruise_control`-specific hard deny and the three hardcoded-id branches; rename `CruiseControlReview` → `PermissionModuleReview` with an alias.
- `packages/kancode/src/session/processor.ts` — preserve a named set of module-review keys instead of hardcoding `previous.cruise_control`.
- `packages/kancode/src/agent/cruise-control.ts` — new home for the agent prompt and ruleset.
- `packages/tui/src/permission/module-commands.tsx` — the cruise builder moves out; `packages/tui/src/util/cruise-control.ts` stays (the tool-call renderer is not reachable from plugin slots).

**Config / compat**
- `permission_modules.cruise_control` keeps its current schema, so existing configs, `$schema` autocomplete, and agents referencing `cruise_control` all keep working with no migration. The `keybinds.permission_cruise_control_model` slot is retained as an alias.

**Dependencies**
- The extracted plugin drops `effect` entirely (the host pins a patched `4.0.0-beta.83` — the largest avoidable version-skew risk) and depends only on `@kancode/plugin` types.
- New cross-repo release coupling with `@puetsua/kancode-cruise-control`, gated by `engines.opencode`.

**Risk**
- Granting plugins model access adds a metered, paid egress channel; per-call logging, a per-plugin concurrency cap, and a per-turn budget are required, not optional.
- The `<conversation_context>` envelope becomes a host↔plugin wire contract and must be documented as such.
