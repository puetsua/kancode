## ADDED Requirements

### Requirement: First-Party Default Plugin Seeding

KanCode SHALL seed designated first-party plugins into the user's **global** config on first run so they install and activate without manual setup. Seeding MUST write through the existing plugin config-patching path so JSONC comments and formatting are preserved, MUST be lock-guarded against concurrent writers, and MUST target only global scope — project config directories MUST NOT be seeded.

Seeding MUST be skipped entirely when default plugins are disabled or when running in pure mode.

#### Scenario: Fresh install seeds the plugin
- **WHEN** KanCode starts with no prior seed marker and default plugins are enabled
- **THEN** the plugin entry is written into the global config and the plugin is installed in the background

#### Scenario: Comments in global config survive seeding
- **WHEN** the global config contains JSONC comments and seeding writes a plugin entry
- **THEN** the existing comments and formatting are preserved

#### Scenario: Project config is never seeded
- **WHEN** seeding runs in a workspace containing a project config directory
- **THEN** only the global config is modified

#### Scenario: Disabled default plugins skip seeding
- **WHEN** default plugins are disabled or pure mode is active
- **THEN** no config is written and no seed marker is recorded

### Requirement: Seeding Is Idempotent And Permanently Opt-Out-Able

Seeding decisions MUST be recorded in a state marker outside the user's config. A plugin MUST be seeded only when no marker exists for it. Removing a seeded entry from config MUST be permanent — a subsequent start MUST NOT re-add it. An explicit disable in config MUST also suppress the plugin even when the state marker is absent, so opt-out survives a state directory wipe.

#### Scenario: Second start does not re-seed
- **WHEN** a seed marker already exists for a plugin
- **THEN** the config is not modified again

#### Scenario: User removal is permanent
- **WHEN** a user deletes a seeded plugin entry from global config and restarts
- **THEN** the entry is not restored

#### Scenario: Explicit disable survives a state wipe
- **WHEN** the user has explicitly disabled the plugin in config and the state marker is missing
- **THEN** the plugin is neither seeded nor loaded

#### Scenario: User pin is not overwritten
- **WHEN** the global config already lists the plugin at a pinned version
- **THEN** seeding leaves that entry unchanged

### Requirement: Seeded Plugins Float And Degrade Offline

Seeded entries MUST be written without a version so the plugin picks up fixes without a KanCode release, relying on the plugin compatibility gate to reject mismatched pairs. Plugin installation MUST NOT block startup, and an installation failure for a seeded plugin MUST surface as a warning rather than a session error, so KanCode remains fully usable offline.

#### Scenario: Seeded entry is unpinned
- **WHEN** seeding writes a plugin entry
- **THEN** the entry records the bare package name with no version constraint

#### Scenario: Offline start is not blocked
- **WHEN** KanCode starts with no network and a seeded plugin is not yet installed
- **THEN** startup completes normally and the failure is reported as a warning, not a session error

#### Scenario: Incompatible plugin version is skipped
- **WHEN** an installed seeded plugin declares a compatibility range excluding the running KanCode version
- **THEN** the plugin is not loaded and the mismatch is reported
