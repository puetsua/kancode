## ADDED Requirements

### Requirement: Plugin Model Generation Capability

KanCode SHALL expose a model generation capability on the V1 plugin input so plugins can obtain schema-validated structured completions from a user-configured model. The capability MUST accept a model reference, a message list, and a JSON Schema, and MUST return the validated object together with the resolved model identity and, when the provider reports it, token usage.

The capability MUST resolve provider credentials host-side. Plugins MUST NOT receive an API key, an authenticated SDK handle, or any other credential material. The request and result MUST be plain JSON-serializable data so the same contract can later be served over HTTP without changing the plugin-facing shape.

#### Scenario: Plugin classifies with a configured model
- **WHEN** a plugin calls the capability with model ref `opencode/deepseek-v4-flash`, a message list, and a JSON Schema
- **THEN** the host resolves that model through the normal provider stack and returns the schema-validated object

#### Scenario: Credentials are not reachable from the result
- **WHEN** a plugin inspects a successful result
- **THEN** the result contains only the validated object, the resolved model identity, and optional usage
- **AND** no provider SDK handle, API key, or auth token is reachable from it

#### Scenario: Model reference is mandatory
- **WHEN** a plugin calls the capability without a model reference
- **THEN** the call fails with a non-retryable `model_unset` error
- **AND** the host MUST NOT substitute a default, small, or session model

### Requirement: Model Capability Error Taxonomy

Capability failures MUST reject with a typed error carrying a stable machine-readable `code` and a `retryable` flag, so callers can distinguish permanent misconfiguration from transient faults. The codes MUST include `model_unset`, `model_not_found`, `auth`, `timeout`, `aborted`, `no_object`, `rate_limit`, `provider_error`, and `unavailable`. A `no_object` error MUST carry the raw model text so the caller can attempt its own lenient recovery.

#### Scenario: Unknown model is not retried
- **WHEN** a plugin requests a model reference that does not resolve
- **THEN** the error carries code `model_not_found` with `retryable` false

#### Scenario: Unparseable output exposes raw text
- **WHEN** the model returns output that does not satisfy the supplied JSON Schema
- **THEN** the error carries code `no_object` with the raw model text attached

#### Scenario: Capability used before providers are available
- **WHEN** a plugin calls the capability before the provider stack has initialized
- **THEN** the call fails with code `unavailable` and the host does not crash or deadlock

### Requirement: Model Capability Timeout Ownership

The host SHALL own per-call timeouts only. When a call exceeds its `timeoutMs`, the host MUST abort the underlying request rather than merely abandoning the promise, and MUST reject with the `timeout` code. Retry counts, backoff, serialization, and inter-call pacing are caller policy and MUST NOT be imposed by the host.

#### Scenario: Timeout aborts the underlying request
- **WHEN** a call exceeds its configured `timeoutMs`
- **THEN** the error carries code `timeout`
- **AND** the underlying provider request is aborted rather than left running

#### Scenario: Host does not retry on behalf of the plugin
- **WHEN** a call fails with a retryable code
- **THEN** the host returns that failure to the caller without re-issuing the request

### Requirement: Model Capability Cost And Abuse Guardrails

Because the capability spends the user's inference budget, every call MUST be recorded in a structured log including the calling plugin id, the resolved model, and reported token usage, without logging prompt secrets. The host MUST enforce a per-plugin concurrency cap and a per-turn call budget so a buggy or runaway plugin cannot consume unbounded spend.

#### Scenario: Calls are attributable to a plugin
- **WHEN** a plugin completes a generation call
- **THEN** a structured log records the plugin id, resolved model, and token usage

#### Scenario: Runaway plugin is bounded
- **WHEN** a plugin exceeds its per-turn call budget
- **THEN** further calls in that turn fail rather than being issued to the provider

### Requirement: Plugin Application Path Access

The V1 plugin input SHALL expose the resolved KanCode application directories — config, data, cache, state, and tmp — so plugins can reason about managed application paths without importing unpublished host packages.

#### Scenario: Plugin resolves managed app directories
- **WHEN** a plugin reads the exposed paths
- **THEN** it receives the same resolved roots the host uses for config, data, cache, state, and tmp
