#Requires -Version 7
<#
.SYNOPSIS
  Moves the unscoped KanCode packages under the `kancode` npm organization.

.DESCRIPTION
  The platform binaries keep their unscoped `kancode-<platform>` names. Only the
  *ownership* moves: they are currently owned by the user `puetsua`, and this
  hands them to the `kancode` org so the org's members and tokens administer
  them instead of one personal account.

  Republishing does NOT do this. A publish uploads a new version to a package
  that already exists; it never changes who owns that package. The registry
  operation that moves an unscoped package into an org is:

      npm access grant read-write <org>:<team> <package>

  which is the CLI equivalent of "+ Add Existing Package" on the org's Teams
  page. npm supports this for unscoped packages by design — see
  https://docs.npmjs.com/about-organization-scopes-and-packages
  ("you can also use organizations to manage unscoped packages").

  What this handles, and what it deliberately does not:

    1. the 12 `kancode-<platform>` binaries   -> granted to <org>:<team>
    2. the unscoped app `kancode`             -> granted once it exists on npm
    3. @puetsua/kancode                       -> deprecated, with -DeprecateOldApp

  (2) is a no-op today: `kancode` has never been published, so there is nothing
  to grant. Publish it through the release pipeline first, then re-run this
  script — every step is idempotent and skips what is already done.

  (3) is a rename, not a move. A scoped package cannot be transferred at all,
  because the scope *is* the owner ("You cannot transfer a scoped package to
  another user account or organization" — npm docs). The only path off
  @puetsua/kancode is to publish unscoped `kancode` and deprecate the old name,
  so -DeprecateOldApp refuses to run until the replacement is actually on npm.

.PARAMETER Org
  The npm organization that should end up owning the packages.

.PARAMETER Team
  The team within the org to grant read-write to. Every org has `developers`.

.PARAMETER Otp
  A 2FA one-time password. Omit when running interactively: npm prompts per
  operation, which is more reliable than one code across a dozen writes that
  take longer than the ~30s code lifetime.

.PARAMETER DeprecateOldApp
  Also deprecate @puetsua/kancode in favour of unscoped `kancode`.

.PARAMETER DryRun
  Report what would change without granting or deprecating anything.

.EXAMPLE
  pwsh script/transfer-npm-org.ps1 -DryRun
  pwsh script/transfer-npm-org.ps1
  pwsh script/transfer-npm-org.ps1 -DeprecateOldApp
#>
[CmdletBinding()]
param(
  [string]$Org = "kancode",
  [string]$Team = "developers",
  [string]$Otp,
  [switch]$DeprecateOldApp,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step { param([string]$Text) Write-Host "`n=== $Text ===" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "  $Text" -ForegroundColor Green }
function Write-Skip { param([string]$Text) Write-Host "  $Text" -ForegroundColor DarkGray }
function Write-Warn { param([string]$Text) Write-Host "  $Text" -ForegroundColor Yellow }
function Write-Bad  { param([string]$Text) Write-Host "  $Text" -ForegroundColor Red }

# npm writes take --otp only when 2FA demands one; passing an empty value errors.
function Npm-Args { param([string[]]$Base) if ($Otp) { return $Base + @("--otp", $Otp) } else { return $Base } }

# The app wrapper. Unscoped, and must stay in sync with Installation.NPM_PACKAGE.
$AppPackage = "kancode"
$OldAppPackage = "@puetsua/kancode"

# One entry per build target in packages/kancode/script/build.ts (`allTargets`),
# named by the same rule: <bin>-<os>-<arch>[-baseline][-musl], with win32 -> windows.
# Adding a target there means adding it here.
$BinaryPackages = @(
  "kancode-linux-arm64"
  "kancode-linux-arm64-musl"
  "kancode-linux-x64"
  "kancode-linux-x64-baseline"
  "kancode-linux-x64-baseline-musl"
  "kancode-linux-x64-musl"
  "kancode-darwin-arm64"
  "kancode-darwin-x64"
  "kancode-darwin-x64-baseline"
  "kancode-windows-arm64"
  "kancode-windows-x64"
  "kancode-windows-x64-baseline"
)

function Get-PublishedVersion {
  param([string]$Name)
  $v = & npm view $Name version --silent 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $v) { return $null }
  return $v.Trim()
}

# Authoritative answer to "does the org administer this package?". `npm owner ls`
# is not: it keeps reporting the original publisher after a grant.
function Get-OrgPackages {
  $raw = & npm access list packages $Org --json 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $raw) { return @{} }
  return ($raw -join "`n" | ConvertFrom-Json -AsHashtable)
}

function Grant-Package {
  param([string]$Name, [hashtable]$Owned)

  $version = Get-PublishedVersion $Name
  if (-not $version) {
    Write-Skip "$Name not on the registry - nothing to move"
    return "absent"
  }

  if ($Owned.ContainsKey($Name)) {
    Write-Skip "$Name@$version already managed by @$Org ($($Owned[$Name]))"
    return "already"
  }

  if ($DryRun) {
    Write-Warn "would grant ${Org}:${Team} read-write on $Name@$version"
    return "would"
  }

  & npm @(Npm-Args @("access", "grant", "read-write", "${Org}:${Team}", $Name))
  if ($LASTEXITCODE -ne 0) {
    Write-Bad "grant failed for $Name"
    Write-Bad "  transfer it by hand at https://www.npmjs.com/package/$Name/access"
    return "failed"
  }

  Write-Ok "moved $Name@$version to @$Org"
  return "moved"
}

Write-Step "Preflight"
$who = & npm whoami 2>$null
if ($LASTEXITCODE -ne 0) { throw "not logged in to npm; run 'npm login' first" }
Write-Ok "authenticated as $who"

$roster = & npm org ls $Org 2>$null
if ($LASTEXITCODE -ne 0) { throw "cannot read the @$Org org; you must be a member to administer its packages" }
$role = ($roster | Select-String -Pattern "^\s*$([regex]::Escape($who))\s+-\s+(\S+)").Matches.Groups[1].Value
if (-not $role) { throw "$who is not a member of @$Org" }
if ($role -ne "owner" -and $role -ne "admin") {
  throw "$who is '$role' in @$Org; granting team access to a package needs owner or admin"
}
Write-Ok "$who is $role of @$Org"

$teams = & npm team ls $Org 2>$null
if ($LASTEXITCODE -ne 0 -or -not ($teams -match "${Org}:${Team}\b")) {
  throw "team ${Org}:${Team} not found; create it with 'npm team create ${Org}:${Team}'"
}
Write-Ok "target team ${Org}:${Team}"

if ($DryRun) { Write-Warn "DRY RUN - nothing will be granted or deprecated" }

$owned = Get-OrgPackages
Write-Ok "@$Org currently manages $($owned.Count) package(s)"

Write-Step "Move the platform binaries"
$results = @{}
foreach ($name in $BinaryPackages) { $results[$name] = Grant-Package -Name $name -Owned $owned }

Write-Step "Move the app wrapper"
$results[$AppPackage] = Grant-Package -Name $AppPackage -Owned $owned
if ($results[$AppPackage] -eq "absent") {
  Write-Warn "'$AppPackage' has never been published. Release it first:"
  Write-Warn "  git tag <version> && git push --follow-tags"
  Write-Warn "then re-run this script to hand it to @$Org."
}

if ($DeprecateOldApp) {
  Write-Step "Deprecate $OldAppPackage"
  # Pointing users at a replacement that does not exist is worse than saying nothing.
  if (-not (Get-PublishedVersion $AppPackage)) {
    Write-Warn "skipped: '$AppPackage' is not on npm yet, so the notice would point nowhere"
  } elseif ($DryRun) {
    Write-Warn "would deprecate $OldAppPackage"
  } else {
    & npm @(Npm-Args @("deprecate", $OldAppPackage, "Renamed to '$AppPackage'. Install that instead."))
    if ($LASTEXITCODE -ne 0) { Write-Bad "deprecate failed for $OldAppPackage" }
    else { Write-Ok "deprecated $OldAppPackage" }
  }
}

Write-Step "Verify"
if ($DryRun) {
  Write-Skip "dry run - registry state unchanged"
} else {
  $after = Get-OrgPackages
  foreach ($name in ($BinaryPackages + $AppPackage)) {
    if ($after.ContainsKey($name)) { Write-Ok "$name -> @$Org ($($after[$name]))" }
    elseif ($results[$name] -eq "absent") { Write-Skip "$name not published" }
    else { Write-Bad "$name STILL NOT under @$Org" }
  }
}

$moved   = @($results.Values | Where-Object { $_ -eq "moved" }).Count
$already = @($results.Values | Where-Object { $_ -eq "already" }).Count
$absent  = @($results.Values | Where-Object { $_ -eq "absent" }).Count
$failed  = @($results.Values | Where-Object { $_ -eq "failed" }).Count
Write-Host "`nmoved $moved, already there $already, not published $absent, failed $failed"

Write-Host @"

Not handled here:
  - Ownership moves do not touch the OIDC trusted publisher configured per
    package on npmjs.com. Confirm the release workflow still publishes after
    the move, before cutting the next tag.
  - '$OldAppPackage' cannot be transferred - a scoped package's scope is its
    owner. Publishing unscoped '$AppPackage' and deprecating the old name is
    the whole migration.
  - The @$Org/* libraries (sdk, plugin, cruise-control) are already org-owned
    by virtue of their scope.
"@ -ForegroundColor DarkGray

if ($failed -gt 0) { exit 1 }
