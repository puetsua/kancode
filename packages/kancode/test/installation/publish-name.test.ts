import { expect, test } from "bun:test"
import { readFile } from "fs/promises"
import path from "path"
import { NPM_PACKAGE } from "@/installation"

/**
 * `script/publish.ts` decides what name lands on npm; `Installation.NPM_PACKAGE`
 * decides what an installed CLI polls for updates and tells users to uninstall.
 * They are separate constants in separate files, and nothing at runtime notices
 * when they disagree — the app just silently stops seeing its own releases.
 */
test("publish name matches the name the installed CLI self-updates from", async () => {
  const script = await readFile(path.join(import.meta.dir, "..", "..", "script", "publish.ts"), "utf8")
  const match = script.match(/const publishName = "([^"]+)"/)
  expect(match?.[1]).toBeDefined()
  expect(match![1]).toBe(NPM_PACKAGE)
})

test("uninstall instructions do not hardcode a package name", async () => {
  const source = await readFile(
    path.join(import.meta.dir, "..", "..", "src", "cli", "cmd", "uninstall.ts"),
    "utf8",
  )
  // Hardcoding here is how the name drifted out of sync in the first place.
  expect(source).not.toContain("@puetsua/kancode")
  expect(source).toContain("NPM_PACKAGE")
})
