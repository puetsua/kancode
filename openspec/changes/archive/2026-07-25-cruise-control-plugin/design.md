## Context

Cruise Control spans three packages. The classifier (`packages/kancode/src/plugin/cruise-control/`, ~900 lines) is a V1 built-in plugin registered via `permission.registerModule`; the `cruisecontrol` agent is a V2 core plugin using `ctx.agent.transform`; the `/cruise-control-model` command is a TUI built-in. V1 has no agent registration API and V2 has no permission domain, so no single plugin generation covers all three.

`classifier.ts` imports `generateObject` from `ai` plus `@/provider/provider`, `@/config/config`, `@/tool/json-schema`, `@/session/cruise-control-prompt`, and three `@kancode/core/*` modules. `@kancode/core` and `@kancode/schema` are `private: true`. External plugins receive `{ client, project, directory, worktree, experimental_workspace, permission, serverUrl, $ }` — no model access. The server HTTP API has no generation endpoint, and `ctx.aisdk` is a model-construction transform, not a call path. Extraction is therefore blocked on a genuinely missing host capability, not on refactoring.

A load-order constraint shapes the solution: `Provider.node` declares `deps: [..., Plugin.node, ...]`, which is why cruise-control is already lazily imported at `plugin/index.ts:245`. Anything giving plugins model access must not resolve `Provider` while `PluginInput` is being constructed.

## Goals / Non-Goals

**Goals:**
- Give plugins a first-class, reusable way to obtain structured model completions, with the host owning credentials.
- Reduce the classifier to code that imports nothing but `@kancode/plugin` and node builtins, verified mechanically.
- Keep KanCode fully usable offline and during the window before the plugin installs.
- Preserve every existing user config, agent reference, and keybind without migration.
- Land the enabling work as independently shippable improvements before the external repo exists.

**Non-Goals:**
- A V2 `PluginContext` model domain. `packages/core` has no `Provider` service; adding one inverts the dependency for zero consumers.
- An HTTP generation endpoint. Deliberately deferred, though the payload shape is chosen so one can be added later without changing the plugin contract.
- A plugin marketplace, registry, or trust list.
- Moving the `cruisecontrol` agent out of the host (see Decisions).
- Restoring any pruned non-TUI surface.

## Decisions

### In-process capability object, not an HTTP endpoint

V1 plugins are `import()`ed into the server process and already receive live objects (`$`, `permission.registerModule`), so there is no boundary to cross. The classifier sits on the hot path of every gated tool call; a local round-trip adds latency for nothing. More importantly, `POST /generate` accepting a model ref plus arbitrary messages is an arbitrary-inference proxy reachable by anything holding the `ServerAuth` token — strictly worse than a function reachable only by code the user chose to install.

*Alternative considered:* HTTP endpoint first, for out-of-process plugins. Rejected now, kept possible: the payload is plain JSON in / plain JSON out with no live SDK objects and no callbacks, so it can be mirrored later without changing the plugin-facing shape.

### Data-only contract: no `ai` types, no Effect Schema, no callbacks

`ModelMessage` is declared structurally in `@kancode/plugin` rather than re-exported from `ai`, and the schema parameter is plain JSON Schema rather than Effect Schema. Re-exporting either would make every plugin inherit KanCode's pinned `ai` version and its *patched* `effect@4.0.0-beta.83`.

Today's classifier passes `validate` and `experimental_repairText` callbacks into `generateObject` to recover flaky output. Instead, the host throws a typed `no_object` error carrying the raw text and the plugin does its own lenient recovery — which `classifier.ts:729-733` already implements in its catch block. Nothing is lost and the boundary stays serializable.

### Host owns timeouts; plugins own retry policy

`timeoutMs` is enforced host-side with a real abort so the request actually dies. Retries, backoff, the classify semaphore, and `classify_gap_ms` stay in the plugin — they are policy, not infrastructure. A typed `retryable` flag lets callers stop retrying permanent failures; today `classifier.ts:641-657` retries everything three times, including "that model does not exist."

### Lazy `Provider` resolution over the existing bridge

`input.model.generate` closes over the `EffectBridge` already created at `plugin/index.ts:177` and resolves `Provider.Service` via `Effect.serviceOption` **inside each call**. Early-boot calls degrade to an `unavailable` error rather than crashing or deadlocking on the `Provider` → `Plugin` dependency. This is guarded by a dedicated test rather than a comment.

### The `cruisecontrol` agent stays in the host

Moving it would require a third install target kind (`install.ts` knows only `server` and `tui`, and `patchPluginList` hardcodes the `["plugin"]` JSON path) plus a parallel patch path for V2's object-entry `plugins` array. Worse, its default ruleset is `"*": "cruise_control"`, so an agent shipped without its classifier would escalate *every* action. Keeping the agent in-host makes "classifier missing" degrade coherently to "CruiseControl asks more," and keeps user `agent.cruisecontrol` overrides working untouched.

### Config schema stays host-owned

`permission_modules` is already typed as `Record<string, Options>`, and that option set (model, retries, timeout, allowlist, never_auto, dynamic_list, pacing) is a reasonable shape for *any* LLM permission module rather than a Cruise-Control leak. Keeping it host-side means existing configs validate unchanged and `$schema` autocomplete keeps working whether or not the plugin is installed. A plugin-contributed schema is not achievable anyway: `schemas/kancode.schema.json` is generated at build time and served from a raw.githubusercontent URL.

### Unknown module asks; registered-module errors still deny

Splitting these two cases is what makes offline operation survivable. Absence of a registration is a *deployment* state, not a safety signal, so it escalates to a human. A registered module that throws, times out, or returns garbage is a *safety* failure and keeps denying. As a side benefit, a typo'd module id now asks with a clear reason instead of silently denying every action.

### Config read via TTL-cached SDK call, not the `config` hook

`Hooks.config` fires once at plugin init, but the classifier reads config on every decide so `/cruise-control-model` takes effect immediately. Caching init-time config would silently require a restart. The plugin uses `client.config.get()` with a short TTL instead.

### Seeding keyed on a state marker, not on config contents

The existing `patchPluginConfig` no-ops while an entry is present but would happily re-add one the user deleted. A marker under the state directory records that seeding already happened, making removal permanent. An explicit config-level disable is honored independently so opt-out survives a state wipe — which also motivates adding server-side plugin enablement, since only the TUI has it today.

### Seeded entries float

Bare specs resolve to `latest` and refresh when stale; a pinned `pkg@1.2.3` is never rechecked. Floating is required for "ship classifier fixes without a KanCode release," and `engines.opencode` already gates incompatible pairs. Users who want determinism pin the entry themselves, and duplicate detection matches by package name so seeding will not fight them.

### Default instructions applied, not persisted

`ensureDefaultInstructions` writes ~25 lines of prose into the user's global config on first run. It needs `Config.updateGlobal` (unavailable externally), and — independent of that — it goes stale on every plugin update in a file the user never edited. `resolveInstructions` already fills defaults when unset, so removing the write changes nothing a user can observe except that improved defaults now actually ship.

## Risks / Trade-offs

**[Version skew across two repos]** → `engines.opencode` yields a *skip*, not a fix. Keep the contract data-only, bump the compatibility range on every breaking API change, and add a nightly CI job that installs the published plugin and runs one real classify. Accept that mismatched pairs land in ask-fallback rather than failing loudly.

**[Offline and first-run degradation — the largest real cost]** → KanCode's permission system works fully offline today. Afterward, a cold offline start leaves `cruise_control` unregistered, and because the `cruisecontrol` agent's ruleset is `"*": "cruise_control"`, it asks for every action. Mitigated by seeding before `plugin_origins` is computed (so it activates on the same boot), a detached install that never blocks startup, and a one-time explanatory notice instead of dozens of silent asks. If this proves painful in practice, a minimal in-host deterministic rail is the escape hatch.

**[Granting plugins metered model access]** → Plugins already have `Bun.$`, so this is not a new capability *class*, but it adds a paid egress channel that looks like ordinary traffic, and an unbounded loop in a merely buggy plugin burns real money. Per-call structured logging with plugin attribution, a per-plugin concurrency cap, and a per-turn budget are required, not optional. Small and default models are deliberately not exposed, so a plugin cannot quietly spend on the user's expensive main model. This must not be rationalized as safe because the API key is hidden: the key is not the asset, the inference budget and the prompt channel are.

**[The approval envelope becomes a wire contract]** → `explicitApprovalIntent` is duplicated into the plugin rather than moved, because the host still produces the `<conversation_context>` envelope while the plugin parses it. This is the worst new coupling the split introduces; it is documented as a stable contract in the permission-modules spec so it cannot drift silently.

**[Bundled skill documentation degrades]** → The `customize-opencode` skill ships Cruise Control's option list *to the model*. A V1 server plugin cannot contribute skills (those are V2 `ctx.skill`). A short pointer stays in the KanCode skill and detail moves to the plugin README, so the model loses inline knowledge of the option list. Unavoidable given the split.

**[Two-repo release burden]** → Separate CI, changelog, versioning, and npm credentials, and every tweak becomes publish-then-wait-for-stale-check. Escape hatch: all the enabling work is identical either way, so if the burden bites, the same portable code can ship from a `packages/cruise-control/` workspace with `private: false` — identical install/pin/remove semantics from one CI with atomic cross-cutting changes. Only the extraction step would change.

## Migration Plan

Enabling work lands first and independently: the ask-fallback, review-metadata generalization, `input.paths` plus server-side plugin enablement, and the model capability are each shippable while Cruise Control is still built in. The in-tree classifier is then refactored onto the public capability and stripped of host imports — at that point it is portable and the mechanical import check enforces it.

Extraction publishes the package and verifies it manually against a local config with the in-tree copy disabled. Seeding and in-tree removal **must land together or removal first**: if seeding activates while the built-in still registers `cruise_control`, `registerSync` throws "already registered" and the external plugin fails to load.

Existing users see one degraded session on the upgrade boot while the plugin installs, covered by a one-time notice. Rollback is a clean revert of the removal step; a flag-gated duplicate copy of the classifier is deliberately not kept, since two copies are worse than one revert.

## Open Questions

- Should the model capability be gated on an explicit `capabilities` declaration in the plugin's `package.json`, so the grant is auditable at load time rather than implicit for every plugin?
- What per-turn call budget is high enough not to break legitimate classification bursts under `parallel_classify`, yet low enough to bound a runaway loop?
- Does the one-time upgrade notice belong in the TUI notification surface or as a session-level system message?
