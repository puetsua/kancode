## MODIFIED Requirements

### Requirement: Built-In cruise_control Module

KanCode SHALL ship Cruise Control as an externally distributed plugin (`@puetsua/kancode-cruise-control`) that registers permission module ID `cruise_control` through the public plugin registration API, and SHALL seed that plugin into global config on first run so it is available without manual setup. The module MUST be installable, pinnable, and removable independently of the KanCode release cycle. The name `cruise_control` is KanCode’s product term; comparisons to Copilot Autopilot or Claude Code auto mode are conceptual inspiration only and MUST NOT appear as module IDs or config keys.

The `cruisecontrol` **agent** remains built in to KanCode and MUST NOT depend on the plugin being installed. When the agent is active but the classifier module is unregistered, its gated actions escalate to human ask.

#### Scenario: cruise_control is the classifier id
- **WHEN** a user configures `permission.bash` to `"cruise_control"` with valid `permission_modules.cruise_control` options and the plugin is installed
- **THEN** the LLM classifier module handles the gated bash permission decision

#### Scenario: Plugin installs without manual setup
- **WHEN** a user starts KanCode for the first time with default plugins enabled
- **THEN** the Cruise Control plugin is seeded into global config and installed in the background

#### Scenario: Agent survives a missing classifier
- **WHEN** the `cruisecontrol` agent is selected and the classifier plugin is not installed
- **THEN** the agent still runs and its gated actions escalate to human ask rather than being denied

#### Scenario: Custom module ids remain available
- **WHEN** a plugin registers `puetsua_permit`
- **THEN** users may set permission actions to `"puetsua_permit"` independently of `cruise_control`

### Requirement: User-Configured Classifier Model

The `cruise_control` module SHALL require a configured model reference under `permission_modules.cruise_control.model` (for example `opencode/deepseek-v4-flash` or `ollama-cloud/kimi-k2.7-code`). The module MUST resolve that model through the host's plugin model capability rather than reaching into host internals, and MUST NOT receive provider credentials. An unset model MUST resolve to host-side `ask` with a hint naming the configuration command — never `allow` and never a hard deny, since an unset model is user configuration rather than a safety failure. A model that is set but unresolvable MUST fail closed and MUST NOT allow.

The module MUST read its configuration freshly enough that changing the model at runtime takes effect without restarting KanCode.

#### Scenario: Classify with deepseek flash
- **WHEN** `permission_modules.cruise_control.model` is `opencode/deepseek-v4-flash` and a gated tool permission is evaluated
- **THEN** `cruise_control` invokes that model through the plugin model capability to produce an allow/deny decision

#### Scenario: Classify with ollama cloud model
- **WHEN** `permission_modules.cruise_control.model` is `ollama-cloud/kimi-k2.7-code` and a gated tool permission is evaluated
- **THEN** `cruise_control` invokes that model through normal provider resolution

#### Scenario: Unset model asks with a configuration hint
- **WHEN** a rule selects `cruise_control` but `permission_modules.cruise_control.model` is unset
- **THEN** the effective decision is host-side ask and the reason names the command used to set the model
- **AND** the decision MUST NOT be `allow`

#### Scenario: Set but unresolvable model fails closed
- **WHEN** `permission_modules.cruise_control.model` is set to a reference that cannot be resolved
- **THEN** the effective decision is not allow

#### Scenario: Model change takes effect without restart
- **WHEN** the user changes the configured classifier model during a session
- **THEN** the next classification uses the new model without requiring a restart

### Requirement: Classifier Input And Output Contract

The `cruise_control` classifier MUST receive a structured, non-executable summary of the permission request (permission key, patterns/resources, tool metadata, truncated args) with tool args placed in a delimited data section that MUST NOT be treated as system instructions. The classifier LLM MUST return schema-validated JSON with a `decision` of `allow` or `deny` (and a reason string). Invalid or unparseable output MUST map to `fallback`. Host-side ask remains available for missing model, `never_auto`/allowlist rails, timeout, and parse failure.

Classifier guidance MUST be configurable via `permission_modules.cruise_control.instructions` with optional `background`, `allow`, `conditional`, and `deny` string arrays. When the whole `instructions` object or individual sections are omitted, KanCode MUST apply built-in defaults for the missing sections at classification time and MUST NOT wipe sections the user already set (including empty arrays). Defaults MUST NOT be written into the user's config, so that improved defaults ship with the plugin instead of going stale in a file the user never edited. Legacy `system_prompt` MUST NOT be part of the schema.

#### Scenario: Valid allow decision
- **WHEN** the classifier returns valid JSON `{ "decision": "allow", "reason": "..." }` for a permission key on the allowlist and not on `never_auto`
- **THEN** the tool permission is allowed without showing the human ask UI

#### Scenario: Uncertain or invalid output uses fallback
- **WHEN** the classifier returns invalid JSON, omits `decision`, returns `ask`, or otherwise cannot be validated
- **THEN** the effective decision is `fallback`
- **AND** the decision MUST NOT be `allow`

#### Scenario: Default instructions when unset
- **WHEN** `permission_modules.cruise_control.instructions` is omitted
- **THEN** the classifier uses the built-in default instructions rendered into the system prompt

#### Scenario: Defaults are not persisted to config
- **WHEN** the classifier runs with `instructions` omitted
- **THEN** the user's config is not modified and no default instruction text is written into it

#### Scenario: Partial instructions merge
- **WHEN** the user configures only some instruction sections
- **THEN** missing sections use built-in defaults and configured sections are preserved as-is

### Requirement: Example Config Shape

Documentation and schema examples for `cruise_control` MUST show module ID `"cruise_control"` and a `permission_modules.cruise_control` block including `model`. The `permission_modules.cruise_control` config schema MUST remain validated by KanCode itself rather than contributed by the plugin, so existing configs keep working and editor autocomplete continues to function whether or not the plugin is installed.

#### Scenario: Documented example uses cruise_control
- **WHEN** a user follows the documented starter config for LLM permission gating
- **THEN** the example uses `"cruise_control"` as the permission action and sets `permission_modules.cruise_control.model` to a concrete ref such as `opencode/deepseek-v4-flash` or `ollama-cloud/kimi-k2.7-code`

#### Scenario: Existing config keeps validating after extraction
- **WHEN** a user upgrades to a KanCode release where Cruise Control is an external plugin
- **THEN** their existing `permission_modules.cruise_control` block validates unchanged and requires no migration
