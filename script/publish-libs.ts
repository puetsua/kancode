#!/usr/bin/env bun
/**
 * Publishes the two npm library packages: @kancode/sdk then @kancode/plugin.
 *
 * Always packs with bun and publishes the resulting tarball. Running
 * `npm publish` inside a package directory uploads the manifest verbatim,
 * including bun's `workspace:` and `catalog:` protocols, which npm rejects with
 * EUNSUPPORTEDPROTOCOL — that is how 0.1.0 of both shipped uninstallable.
 *
 * Order matters: @kancode/plugin declares an exact dependency on the sdk version
 * resolved at pack time, so the sdk must exist on the registry first.
 *
 *   bun script/publish-libs.ts            # publish
 *   bun script/publish-libs.ts --dry-run  # pack and verify only
 */
import { $ } from "bun"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"

const DRY_RUN = process.argv.includes("--dry-run")
// sdk first: plugin's manifest pins the sdk version it was packed against.
const PACKAGES = ["packages/sdk/js", "packages/plugin"]

for (const dir of PACKAGES) {
  const staging = await mkdtemp(path.join(tmpdir(), "kc-publish-"))
  try {
    await $`bun run build`.cwd(dir)
    await $`bun pm pack --destination ${staging}`.cwd(dir).quiet()

    // Relative name run from the staging dir: GNU tar treats a leading `C:` as a
    // remote host on Windows.
    const tarball = (await Array.fromAsync(new Bun.Glob("*.tgz").scan({ cwd: staging })))[0]
    if (!tarball) throw new Error(`no tarball produced for ${dir}`)

    const manifest = JSON.parse(await $`tar -xzOf ${tarball} package/package.json`.cwd(staging).text())
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (typeof spec === "string" && /^(workspace|catalog|link|file):/.test(spec)) {
        throw new Error(`${manifest.name} would publish an unresolvable dependency: ${name}=${spec}`)
      }
    }

    console.log(`${manifest.name}@${manifest.version} -> ${tarball}`)
    if (DRY_RUN) {
      console.log("  dry run, not publishing")
      continue
    }
    await $`npm publish ${tarball} --access public`.cwd(staging)
    console.log(`  published`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
