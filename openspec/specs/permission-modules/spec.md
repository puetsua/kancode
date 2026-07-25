# Permission Modules Specification

## Purpose

Named permission classifier modules (built-in and plugin-registered) that can be selected as V1 permission actions or V2 `ask`+`module` rules, with fail-closed evaluation and auditable structured logging (no dedicated audit store required).
## Requirements
### Requirement: Module IDs Are Valid Permission Actions

The system SHALL accept registered permission module IDs as V1 permission action values in addition to the built-in literals `allow`, `ask`, and `deny`. Reserved literals `allow`, `ask`, and `deny` MUST remain built-in modes and MUST NOT be registerable as module IDs.

#### Scenario: Config names cruise_control for bash
- **WHEN** user config sets `permission.bash` to `"cruise_control"` and `cruise_control` is a registered module
- **THEN** evaluation of a matching bash permission rule resolves to the `cruise_control` module rather than treating the string as an unknown static effect

#### Scenario: Existing allow ask deny still work
- **WHEN** user config sets `permission.edit` to `"ask"` (or `"allow"` / `"deny"`)
- **THEN** behavior matches today's static ruleset evaluation with no module invocation

#### Scenario: Pattern maps still use static actions
- **WHEN** user config sets `permission.bash` to `{ "*": "ask", "git *": "allow" }`
- **THEN** pattern keys are matched with last-match-wins and module options are NOT read from that object

### Requirement: Top-Level Permission Modules Config

The system SHALL load per-module options from a top-level `permission_modules` map in config (project KanCode-only with `kancode.json(c)` and `.kancode/`; user scope remains KanCode-only). Module options MUST NOT be nested inside V1 pattern-map objects.

#### Scenario: Module options loaded from kancode.json
- **WHEN** `kancode.json` contains `permission_modules.cruise_control.model` set to a provider/model ref
- **THEN** the `cruise_control` module receives that model configuration at decision time

#### Scenario: Project OpenCode filename is ignored
- **WHEN** both `kancode.json` and `opencode.json` exist in the same project directory and only `opencode.json` defines `permission_modules`
- **THEN** that OpenCode file is not loaded and module options from it are not applied

### Requirement: Permission Module Registry

The system SHALL provide a permission module registry that includes first-party built-in modules and MAY include modules registered by plugins. Lookup of an unknown module ID at decision time MUST resolve to `ask` — never `allow` — and MUST emit an auditable structured log of the failure (a dedicated audit store is not required). Unknown-module lookup MUST NOT deny, because a module may legitimately be absent while its plugin is still installing, is unavailable offline, or has been removed by the user; denying in that window would make gated tools unusable rather than merely unattended.

Fail-closed `deny` remains the required outcome once a module IS registered and its evaluation fails. The distinction is: **module not registered → ask; registered module errors → deny.**

#### Scenario: Built-in cruise_control is registered
- **WHEN** the process starts with default plugins
- **THEN** module ID `cruise_control` is available in the registry without a user plugin

#### Scenario: Plugin registers custom module
- **WHEN** a plugin registers module ID `puetsua_permit` successfully
- **THEN** config may use `"puetsua_permit"` as a permission action and the registry routes decisions to that module

#### Scenario: Unknown module escalates to ask
- **WHEN** a matching rule action is `"not_a_real_module"` and no such module is registered
- **THEN** the permission decision is `ask` and the human ask UI names the missing module
- **AND** the decision MUST NOT be `allow`
- **AND** an auditable structured log notes the unknown module

#### Scenario: Module not yet installed stays usable
- **WHEN** a rule selects a module whose plugin has not finished installing or could not be installed offline
- **THEN** the gated tool escalates to a human ask rather than being denied

#### Scenario: Registered module failure still denies
- **WHEN** a registered module throws, times out, or returns an unparseable decision
- **THEN** the permission decision is `deny`

#### Scenario: Reserved ID registration rejected
- **WHEN** a plugin attempts to register a module with ID `allow`, `ask`, or `deny`
- **THEN** registration fails with a clear error and the built-in mode is unchanged

### Requirement: Evaluation Order With Modules

Static `allow` and `deny` rules MUST short-circuit without invoking a module. A module MUST be invoked only when the last matching rule selects a module ID (V1) or an `ask` effect with a `module` field (V2). Module outcomes MUST be one of `allow`, `deny`, or `ask`. When the module returns `ask`, the existing human ask / ACP / non-interactive reject path MUST apply.

#### Scenario: Static deny wins before module
- **WHEN** a later matching rule sets the permission to `deny` and an earlier rule named `cruise_control`
- **THEN** the tool call is denied and `cruise_control` is not invoked

#### Scenario: Module returns ask falls through to UI
- **WHEN** a module returns `ask` for a pending tool permission in an interactive TUI session
- **THEN** the existing permission ask UI is shown and awaits a once/always/reject reply

#### Scenario: Module timeout uses fallback
- **WHEN** a module does not return within its configured timeout
- **THEN** the decision is the module's configured `fallback` (`ask` or `deny`)
- **AND** the decision MUST NOT be `allow`

### Requirement: V2 Optional Module Field

V2 permission rules SHALL keep `effect` as the closed set `allow | deny | ask` and MAY include an optional `module` string. When migrating a V1 module action to V2, the system MUST map it to `{ effect: "ask", module: "<id>" }`.

#### Scenario: V1 module action migrates to V2
- **WHEN** V1 config `permission.bash: "cruise_control"` is migrated to V2 rules
- **THEN** the resulting rule has `action` bash, `effect` `ask`, and `module` `cruise_control`

#### Scenario: V2 static allow ignores module
- **WHEN** a V2 rule has `effect: "allow"` and also sets `module`
- **THEN** the effect is allow without invoking the module

### Requirement: Safety And Auditable Logging For Modules

Registered permission modules MUST fail closed to `deny` on classifier/provider errors, timeouts, and unparseable output. Absence of a module registration is not an error of this kind and MUST escalate to `ask` instead. Auto-allow from a module MUST respect configured allowlists and never-auto lists. Classifier or module decisions that allow a tool MUST NOT persist as durable “always” approvals unless the human explicitly replies `always` in the ask UI.

#### Scenario: Empty allowlist cannot auto-allow
- **WHEN** `cruise_control` (or another module with the same policy) has an empty allowlist and the classifier would return allow
- **THEN** the effective decision is not allow (uses `fallback` or deny/ask per module policy)

#### Scenario: Structured log records module decision
- **WHEN** a module produces a decision for a tool permission
- **THEN** a session-local auditable structured log includes module id, decision, permission key, and latency or error without logging secret values
- **AND** a dedicated audit store is not required

### Requirement: Module Review Metadata Is Identity-Agnostic

Structured module assessments surfaced in the UI MUST be recognized by their shape rather than by a hardcoded module ID. Any module returning metadata containing `risk`, `intent`, and a non-empty `reason` MUST receive the same review rendering, denial-reason formatting, and metadata preservation across tool completion as the built-in classifier does.

#### Scenario: Third-party module gets classifier rendering
- **WHEN** a plugin-registered module returns metadata with valid `risk`, `intent`, and `reason`
- **THEN** the review line is formatted and surfaced exactly as for `cruise_control`

#### Scenario: Module without review shape is unaffected
- **WHEN** a module returns metadata lacking `risk`, `intent`, or a non-empty `reason`
- **THEN** no review line is produced and the plain reason string is used

### Requirement: Host-Provided Classifier Context Is A Documented Contract

The host SHALL document the enriched approval prompt envelope it supplies to permission modules as a stable wire contract, because externally distributed modules parse it to detect explicit user approval. Changes to that envelope MUST be treated as breaking changes to the plugin API.

#### Scenario: Envelope shape is specified
- **WHEN** an external module needs to detect that the user explicitly approved a named action
- **THEN** the envelope format supplied by the host is documented and stable across patch releases

### Requirement: Server Plugin Enablement Control

The system SHALL honor an explicit per-plugin enable/disable setting for server-side plugins, mirroring the control already available for TUI plugins. A disabled plugin MUST NOT be loaded and MUST NOT register permission modules.

#### Scenario: Disabled server plugin does not load
- **WHEN** a plugin id is explicitly disabled in config
- **THEN** that plugin is skipped during load and registers nothing

