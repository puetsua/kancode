import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { DEFAULT_PLUGINS, seedDefaultPlugins } from "@/plugin/default-plugins"
import { Global } from "@kancode/core/global"

const MARKER = path.join(Global.Path.state, "default-plugins.json")
const CONFIG = path.join(Global.Path.config, "kancode.json")

let workdir = ""
let savedMarker: string | undefined
let savedConfig: string | undefined

async function readIfPresent(file: string) {
  const handle = Bun.file(file)
  return (await handle.exists()) ? await handle.text() : undefined
}

async function restore(file: string, saved: string | undefined) {
  if (saved === undefined) await rm(file, { force: true })
  else await writeFile(file, saved)
}

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "kc-seed-"))
  savedMarker = await readIfPresent(MARKER)
  savedConfig = await readIfPresent(CONFIG)
  await rm(MARKER, { force: true })
  await mkdir(Global.Path.config, { recursive: true })
})

afterEach(async () => {
  await restore(MARKER, savedMarker)
  await restore(CONFIG, savedConfig)
  await rm(workdir, { recursive: true, force: true })
})

function seed() {
  return Effect.runPromise(seedDefaultPlugins({ directory: workdir, worktree: workdir }))
}

describe("default plugin seeding", () => {
  test("writes the plugin into global config on first run", async () => {
    await writeFile(CONFIG, JSON.stringify({}, null, 2))
    const result = await seed()
    expect(result.seeded).toEqual([...DEFAULT_PLUGINS])
    const config = JSON.parse(await readFile(CONFIG, "utf8"))
    expect(config.plugin).toContain(DEFAULT_PLUGINS[0])
  })

  test("seeds unpinned so the plugin can ship fixes without a host release", async () => {
    await writeFile(CONFIG, JSON.stringify({}, null, 2))
    await seed()
    const config = JSON.parse(await readFile(CONFIG, "utf8"))
    // A scoped name starts with "@"; a second one would mean a pinned version.
    for (const entry of config.plugin as string[]) expect(entry.indexOf("@", 1)).toBe(-1)
  })

  test("preserves JSONC comments in the user's config", async () => {
    await writeFile(CONFIG, '{\n  // keep me\n  "theme": "dark"\n}\n')
    await seed()
    const text = await readFile(CONFIG, "utf8")
    expect(text).toContain("// keep me")
    expect(text).toContain('"theme": "dark"')
  })

  test("a second run does not touch config again", async () => {
    await writeFile(CONFIG, JSON.stringify({}, null, 2))
    await seed()
    const first = await readFile(CONFIG, "utf8")
    const again = await seed()
    expect(again.seeded).toEqual([])
    expect(await readFile(CONFIG, "utf8")).toBe(first)
  })

  // The whole reason seeding keys off a state marker rather than config contents.
  test("does not resurrect an entry the user deleted", async () => {
    await writeFile(CONFIG, JSON.stringify({}, null, 2))
    await seed()
    await writeFile(CONFIG, JSON.stringify({}, null, 2))
    await seed()
    const config = JSON.parse(await readFile(CONFIG, "utf8"))
    expect(config.plugin ?? []).not.toContain(DEFAULT_PLUGINS[0])
  })

  test("leaves an existing user entry alone", async () => {
    await writeFile(CONFIG, JSON.stringify({ plugin: [`${DEFAULT_PLUGINS[0]}@0.1.0`] }, null, 2))
    await seed()
    const config = JSON.parse(await readFile(CONFIG, "utf8"))
    expect(config.plugin).toEqual([`${DEFAULT_PLUGINS[0]}@0.1.0`])
  })

  test("records a marker so the decision survives restarts", async () => {
    await writeFile(CONFIG, JSON.stringify({}, null, 2))
    await seed()
    const marker = JSON.parse(await readFile(MARKER, "utf8"))
    expect(Object.keys(marker)).toEqual([...DEFAULT_PLUGINS])
    expect(marker[DEFAULT_PLUGINS[0]!].seeded_at).toBeGreaterThan(0)
  })
})
