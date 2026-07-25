import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "fs/promises"
import path from "path"

/**
 * Cruise Control is destined to ship as a standalone npm package. It may only
 * depend on the published plugin SDK, node builtins, and its own siblings —
 * anything else (notably `@kancode/core` and `@kancode/schema`, both
 * `private: true`, and `effect`, which the host pins to a patched build) cannot
 * be resolved once the directory moves out of this repo.
 *
 * This guards the boundary mechanically, because a stray import typechecks fine
 * in-tree and only fails after extraction.
 */
const DIR = path.join(import.meta.dir, "..", "..", "src", "plugin", "cruise-control")

const ALLOWED_PACKAGES = new Set(["@kancode/plugin"])
const ALLOWED_BUILTINS = new Set(["path", "node:path", "url", "node:url", "crypto", "node:crypto"])

function importSpecifiers(source: string): string[] {
  const found: string[] = []
  const pattern = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g
  for (const match of source.matchAll(pattern)) found.push(match[1]!)
  for (const match of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) found.push(match[1]!)
  return found
}

describe("cruise-control portability", () => {
  test("imports nothing the standalone plugin could not resolve", async () => {
    const files = (await readdir(DIR)).filter((name) => name.endsWith(".ts"))
    expect(files.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of files) {
      const source = await readFile(path.join(DIR, file), "utf8")
      for (const spec of importSpecifiers(source)) {
        if (spec.startsWith(".")) continue
        if (ALLOWED_PACKAGES.has(spec) || [...ALLOWED_PACKAGES].some((pkg) => spec.startsWith(`${pkg}/`))) continue
        if (ALLOWED_BUILTINS.has(spec)) continue
        offenders.push(`${file}: ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test("does not reach host internals through path aliases", async () => {
    const files = (await readdir(DIR)).filter((name) => name.endsWith(".ts"))
    const offenders: string[] = []
    for (const file of files) {
      const source = await readFile(path.join(DIR, file), "utf8")
      // `@/...` resolves to packages/kancode/src and cannot exist outside this repo.
      if (/from\s*["']@\//.test(source)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})
