# Agent principles (KanCode)

Repo-wide principles only. Package-level `AGENTS.md` owns package detail; `openspec/` owns planning workflow.

## Product

- Display name **KanCode** (`kancode`). Packages `@kancode/*`; app `@kancode/cli` in `packages/kancode`. Effect IDs `@kancode/...`.
- Keep provider catalog/wire id `"opencode"` (OpenCode Zen) — do not rename it.
- TUI/CLI product. Do not assume `packages/app|desktop|web|console` exist.
- Default branch: `main`.

## Config

- Load `kancode.json(c)` only — never `opencode.json(c)`.
- Project dir: `.kancode/` only — no project `.opencode/` discovery. Migrate legacy via built-in `import-opencode` skill. External skill sources (`.claude/`, `.agents/`, `.cursor/`, `.codex/`, `.kilo/`, `.opencode/`) are opt-in via `skills.external` in `kancode.json(c)`; default is none. Config and other resources stay KanCode-only.
- User scope: `~/.kancode` (and XDG paths) — no `~/.opencode` fallback.
- Honor `OPENCODE_*` and `KANCODE_*`; `KANCODE_*` wins.

## Boundaries

- Runtime: Schema → Core; Protocol → Server. Client may use Schema/Protocol, never Core/Server. `sdk-next` composes Client + Core + Server.
- After public Protocol or Server `HttpApi` changes: regenerate from `packages/client` (`bun run generate`). Do not hand-edit `src/generated*`.
- Legacy JS SDK build: `packages/sdk/js/script/build.ts`.

## Git

- Remote: **`origin` = `puetsua/kancode` only**. Do not add or use an `upstream` remote to `anomalyco/opencode`.
- Always pass `--repo puetsua/kancode` to `gh` (PRs, issues, releases, checks). Never open PRs against `anomalyco/opencode`.
- Branches: ≤3 hyphenated words, no slashes or type prefixes (`session-recovery`, not `feat/foo`).
- Commits / PR titles: `type(scope): summary` — `feat|fix|docs|chore|refactor|test`; scopes like `core`, `kancode`, `tui`, `sdk`, `plugin`, `server`, `cli`.

## Release

- npm names: app publishes as **`@kancode/cli`** — unscoped `kancode` is unobtainable, npm's similarity filter rejects it against `keycode`; libraries are **`@kancode/*`** and publish under the name they are imported by — never remap a library at publish time, emitted `.d.ts` cross-references cannot follow. Platform binaries stay unscoped `kancode-<platform>`.
- `@kancode/sdk` and `@kancode/plugin` release together, sdk first: `workspace:*` pins plugin -> sdk at pack time. Pack with `bun pm pack` and publish the tarball — never `npm publish` from a library directory, which uploads bun's `workspace:`/`catalog:` protocols verbatim and makes the package uninstallable (EUNSUPPORTEDPROTOCOL).
- Legacy `@puetsua/kancode` stays published as a deprecated bridge; do not unpublish it or old lockfiles break.

- Tags are semver **`MAJOR.MINOR.PATCH`** with **no `v` prefix** (`0.2.5`, not `v0.2.5`). The Release workflow only triggers on `[0-9]+.[0-9]+.[0-9]+`.
- Choose the bump from commits since the previous KanCode release tag / `kancode` latest:
  - **patch** (`x.y.Z+1`) — bug fixes only (`fix`)
  - **minor** (`x.Y+1.0`) — new user-facing features (`feat`), even if fixes are included
  - **major** (`X+1.0.0`) — breaking changes
- Do not invent a parallel version line (ignore upstream OpenCode `v1.x` tags/releases). Next tag = last KanCode tag + the bump above.
- After pushing a release tag, watch `.github/workflows/release.yml` until it succeeds; confirm the GitHub release and `npm view @kancode/cli version`.

## Code

- Early returns; avoid `else` and `let` reassignment.
- No `any`; prefer inference. Prefer Bun APIs; avoid `try`/`catch` when possible.
- No aliased or star imports; import named exports.
- Prefer functional arrays; don’t extract single-use helpers. Inline single-use values.
- Effect: bind services before calling (no nested `yield* (yield* …)`).
- Drizzle fields: snake_case. Comments only for non-obvious constraints.

## Verify

- Tests and `bun typecheck` run from the **package directory**, never repo root.
- Prefer real implementation over mocks; avoid `globalThis` unless necessary. Never run `tsc` directly.
