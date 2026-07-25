#Requires -Version 7
<#
.SYNOPSIS
  Publishes the KanCode packages under their new names and deprecates the old ones.

.DESCRIPTION
  npm has no rename or move operation. A package name is fixed once published, so
  "moving to the kancode org" means: publish under the new name, then deprecate
  the old name so installs warn and point at the replacement. The old names stay
  on the registry permanently — unpublishing breaks anyone's existing lockfile.

  What this does, in dependency order:

    1. @kancode/sdk@0.1.1        fixes 0.1.0, which shipped `catalog:` unresolved
    2. @kancode/plugin@0.1.1     fixes 0.1.0, which shipped `workspace:*` unresolved
    3. @kancode/cruise-control   was @puetsua/kancode-cruise-control
    4. deprecations              old names + the two broken 0.1.0 versions

  The app (unscoped `kancode`, was @puetsua/kancode) is NOT published here — it
  goes out through the normal release tag and .github/workflows/release.yml.

  Every package is packed with bun first. Publishing a library directory directly
  uploads bun's `workspace:`/`catalog:` protocols verbatim and npm rejects the
  install with EUNSUPPORTEDPROTOCOL — that is exactly how both 0.1.0s shipped
  broken.

.PARAMETER Otp
  A 2FA one-time password. Omit this when running interactively: npm will prompt
  per operation, which is more reliable since codes expire in ~30 seconds and
  this performs several writes.

.PARAMETER DryRun
  Build, pack, and verify without publishing or deprecating.

.EXAMPLE
  pwsh script/migrate-npm-org.ps1 -DryRun
  pwsh script/migrate-npm-org.ps1
#>
[CmdletBinding()]
param(
  [string]$Otp,
  [switch]$DryRun,
  [string]$KancodeRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$PluginRoot = (Join-Path (Split-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path -Parent) "kancode-cruise-control")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step { param([string]$Text) Write-Host "`n=== $Text ===" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "  $Text" -ForegroundColor Green }
function Write-Skip { param([string]$Text) Write-Host "  $Text" -ForegroundColor DarkGray }

# npm writes take --otp only when 2FA demands one; passing an empty value errors.
function Npm-Args { param([string[]]$Base) if ($Otp) { return $Base + @("--otp", $Otp) } else { return $Base } }

function Get-PublishedVersion {
  param([string]$Name)
  $v = & npm view $Name version --silent 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $v) { return $null }
  return $v.Trim()
}

function Publish-Package {
  param([string]$Directory, [string]$ExpectedName)

  Push-Location $Directory
  try {
    $pkg = Get-Content package.json -Raw | ConvertFrom-Json
    if ($pkg.name -ne $ExpectedName) {
      throw "$Directory declares $($pkg.name), expected $ExpectedName"
    }

    $published = Get-PublishedVersion $pkg.name
    if ($published -eq $pkg.version) {
      Write-Skip "$($pkg.name)@$($pkg.version) already published"
      return
    }

    & bun run build
    if ($LASTEXITCODE -ne 0) { throw "build failed for $($pkg.name)" }

    $staging = Join-Path ([System.IO.Path]::GetTempPath()) ("kc-pub-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $staging | Out-Null
    try {
      & bun pm pack --destination $staging | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "pack failed for $($pkg.name)" }

      $tarball = Get-ChildItem -Path $staging -Filter *.tgz | Select-Object -First 1
      if (-not $tarball) { throw "no tarball produced for $($pkg.name)" }

      # bun resolves workspace:/catalog: when packing; confirm before uploading.
      Push-Location $staging
      try {
        $manifest = (& tar -xzOf $tarball.Name package/package.json) -join "`n" | ConvertFrom-Json
        # A zero-dependency package has no `dependencies` key at all.
        foreach ($field in @("dependencies", "peerDependencies", "optionalDependencies")) {
          $deps = $manifest.PSObject.Properties[$field]
          if (-not $deps -or -not $deps.Value) { continue }
          foreach ($dep in $deps.Value.PSObject.Properties) {
            if ($dep.Value -match '^(workspace|catalog|link|file):') {
              throw "$($manifest.name) would publish an unresolvable $field entry: $($dep.Name)=$($dep.Value)"
            }
          }
        }

        Write-Host "  $($manifest.name)@$($manifest.version) -> $($tarball.Name)"
        if ($DryRun) { Write-Skip "dry run, not publishing"; return }

        & npm @(Npm-Args @("publish", $tarball.Name, "--access", "public"))
        if ($LASTEXITCODE -ne 0) { throw "publish failed for $($manifest.name)" }
        Write-Ok "published $($manifest.name)@$($manifest.version)"
      } finally { Pop-Location }
    } finally { Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue }
  } finally { Pop-Location }
}

function Deprecate-Package {
  param([string]$Spec, [string]$Message)

  # `npm view <name>` on a never-published name exits non-zero; skip those.
  $name = $Spec -replace '@[^@/]*$', '' -replace '^$', $Spec
  if ($Spec -notmatch '@[\d]') { $name = $Spec }
  if (-not (Get-PublishedVersion $name)) { Write-Skip "$Spec not on registry, nothing to deprecate"; return }

  if ($DryRun) { Write-Skip "dry run, would deprecate $Spec"; return }
  & npm @(Npm-Args @("deprecate", $Spec, $Message))
  if ($LASTEXITCODE -ne 0) { throw "deprecate failed for $Spec" }
  Write-Ok "deprecated $Spec"
}

Write-Step "Preflight"
$who = & npm whoami 2>$null
if ($LASTEXITCODE -ne 0) { throw "not logged in to npm; run 'npm login' first" }
Write-Ok "authenticated as $who"
if (-not (Test-Path $PluginRoot)) { throw "plugin repo not found at $PluginRoot" }
Write-Ok "kancode: $KancodeRoot"
Write-Ok "plugin:  $PluginRoot"
if ($DryRun) { Write-Host "  DRY RUN — nothing will be published" -ForegroundColor Yellow }

Write-Step "Publish libraries (sdk first: plugin pins the sdk version it packed against)"
Publish-Package -Directory (Join-Path $KancodeRoot "packages/sdk/js") -ExpectedName "@kancode/sdk"
Publish-Package -Directory (Join-Path $KancodeRoot "packages/plugin") -ExpectedName "@kancode/plugin"

Write-Step "Publish the renamed plugin"
Publish-Package -Directory $PluginRoot -ExpectedName "@kancode/cruise-control"

Write-Step "Deprecate superseded names and broken versions"
Deprecate-Package "@puetsua/kancode-cruise-control" "Renamed to @kancode/cruise-control"
Deprecate-Package "@kancode/sdk@0.1.0" "Broken: shipped an unresolved catalog: dependency. Use 0.1.1 or later."
Deprecate-Package "@kancode/plugin@0.1.0" "Broken: shipped an unresolved workspace: dependency. Use 0.1.1 or later."

Write-Step "Verify"
foreach ($name in @("@kancode/sdk", "@kancode/plugin", "@kancode/cruise-control")) {
  $v = Get-PublishedVersion $name
  if ($v) { Write-Ok "$name@$v" } else { Write-Host "  $name NOT PUBLISHED" -ForegroundColor Red }
}

Write-Host @"

Remaining, not handled here:
  - The app publishes as unscoped 'kancode' via a release tag:
      git tag <version> && git push --follow-tags
  - After that lands, deprecate the old app name:
      npm deprecate @puetsua/kancode "Renamed to kancode"
  - The per-platform 'kancode-<platform>' binaries are already unscoped and do
    not move. To put them under the org, transfer ownership on npmjs.com.
"@ -ForegroundColor DarkGray
