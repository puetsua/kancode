#!/usr/bin/env bun
/**
 * Guards the two npm-published library packages.
 *
 * `bun` resolves the `workspace:` and `catalog:` protocols when it packs, but
 * `npm publish` run directly in a package directory does not — it uploads the
 * manifest verbatim. That shipped @kancode/sdk@0.1.0 and @kancode/plugin@0.1.0
 * with `"cross-spawn": "catalog:"` and `"@kancode/sdk": "workspace:*"`, which
 * npm rejects with EUNSUPPORTEDPROTOCOL. Both were uninstallable.
 *
 * Always publish the bun-produced tarball:
 *   cd packages/<pkg> && bun pm pack && npm publish <tarball> --access public
 *
 * Run: bun script/check-publishable.ts
 */
import { $ } from "bun"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"

const PACKAGES = ["packages/sdk/js", "packages/plugin"]
const BAD_PROTOCOL = /^(workspace|catalog|link|file):/

let failed = false
const notes: string[] = []

for (const dir of PACKAGES) {
  const staging = await mkdtemp(path.join(tmpdir(), "kc-pack-"))
  try {
    await $`bun pm pack --destination ${staging}`.cwd(dir).quiet()
    // Relative name, run from the staging dir: GNU tar reads a leading `C:` as a
    // remote host and fails on Windows absolute paths.
    const tarball = (await Array.fromAsync(new Bun.Glob("*.tgz").scan({ cwd: staging })))[0]
    if (!tarball) throw new Error(`no tarball produced for ${dir}`)

    const manifest = JSON.parse(await $`tar -xzOf ${tarball} package/package.json`.cwd(staging).text())
    const problems: string[] = []

    // `bun pm pack` always resolves these, so the tarball alone cannot reveal the
    // real hazard: `npm publish` run in the package directory uploads the source
    // manifest verbatim, protocols and all. Check the source too.
    const source = JSON.parse(await Bun.file(path.join(dir, "package.json")).text())
    const unresolved: string[] = []
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
      for (const [name, spec] of Object.entries(source[field] ?? {})) {
        if (typeof spec === "string" && BAD_PROTOCOL.test(spec)) unresolved.push(`${field}.${name}=${spec}`)
      }
    }
    if (unresolved.length) notes.push(`${source.name}: source uses ${unresolved.join(", ")}`)

    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (typeof spec === "string" && BAD_PROTOCOL.test(spec)) problems.push(`${field}.${name} = ${spec}`)
      }
    }

    // Every exported target must exist in the tarball, or consumers resolve to
    // a file that was never shipped.
    const files = (await $`tar -tzf ${tarball}`.cwd(staging).text()).split("\n").map((line) => line.replace(/^package\//, ""))
    for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
      const targets = typeof value === "string" ? [value] : Object.values(value as Record<string, string>)
      for (const target of targets) {
        const rel = target.replace(/^\.\//, "")
        if (!files.includes(rel)) problems.push(`exports["${subpath}"] -> ${target} not in tarball`)
      }
    }

    if (problems.length) {
      failed = true
      console.error(`✗ ${manifest.name}@${manifest.version}`)
      for (const problem of problems) console.error(`    ${problem}`)
    } else {
      console.log(`✓ ${manifest.name}@${manifest.version}`)
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (failed) {
  console.error("\nPublishing these would produce packages npm cannot install.")
  process.exit(1)
}
