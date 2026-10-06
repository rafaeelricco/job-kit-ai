# Shared helpers for Aside skill install/uninstall on Windows.
# Source only. Source after scripts\agents\lib.ps1.

$script:AsideCoreSkillNames = @('job-profile-root', 'job-store')
$script:AsideSkillNames = @(
  'job-scout', 'job-apply', 'job-prep', 'job-resume-refine', 'job-resume-review',
  'job-profile', 'job-list', 'job-match', 'job-stories',
  'job-inbox', 'job-humanize'
) + $script:AsideCoreSkillNames
$script:AsideLegacySkillNames = @(
  'job-discovery', 'job-application', 'profile-scaffold',
  'application-stage', 'profile-init', 'job-profile-config',
  'job-tracker', 'job-resume', 'job-profile-me', 'job-pitch'
)
$script:AsideKitMarker = '.job-kit'

# Resolve-AsideSkillsRoot
# Default: {KitHome}\.aside\u\{ASIDE_ACCOUNT or 0}\skills\builtin
# Override: absolute ASIDE_SKILLS (rooted, no newline).
function Resolve-AsideSkillsRoot {
  if ($env:ASIDE_SKILLS) {
    if ($env:ASIDE_SKILLS -match "`r|`n") {
      throw "ASIDE_SKILLS must not contain a line break"
    }
    if (-not (Test-RootedPath $env:ASIDE_SKILLS)) {
      throw "ASIDE_SKILLS must be an absolute path"
    }
    return (Get-FullPathNormalized $env:ASIDE_SKILLS)
  }
  $account = '0'
  if ($env:ASIDE_ACCOUNT) { $account = $env:ASIDE_ACCOUNT }
  return (Join-Path $script:KitHome ".aside\u\$account\skills\builtin")
}

# Test-KitSkillCopy DEST REPO NAME
# True when DEST is a real directory (not reparse) whose .job-kit text
# (trailing newline stripped) equals Get-SkillSource REPO NAME.
function Test-KitSkillCopy {
  param(
    [Parameter(Mandatory = $true)][string]$Dest,
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if (-not (Test-Path -LiteralPath $Dest -PathType Container)) { return $false }
  if (Test-ReparsePoint $Dest) { return $false }
  $marker = Join-Path $Dest $script:AsideKitMarker
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { return $false }
  try {
    $text = [IO.File]::ReadAllText($marker).TrimEnd([char]13, [char]10)
  } catch {
    return $false
  }
  return (Test-PathsEqual $text (Get-SkillSource $Repo $Name))
}

# Test-AsideKitOwned DEST REPO NAME
# True when DEST is a kit skill link or a kit-marked copy for NAME.
function Test-AsideKitOwned {
  param(
    [Parameter(Mandatory = $true)][string]$Dest,
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$Name
  )
  return ((Test-KitSkillLink $Dest $Repo $Name) -or (Test-KitSkillCopy $Dest $Repo $Name))
}

# Ensure-AsideSkillsRoot DEST_ROOT
# Creates DEST_ROOT only if its parent already exists (Aside already set up).
function Ensure-AsideSkillsRoot {
  param([Parameter(Mandatory = $true)][string]$DestRoot)
  if (Test-Path -LiteralPath $DestRoot -PathType Container) {
    return
  }
  $parent = Split-Path $DestRoot -Parent
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    throw "Aside skills parent missing: $parent`n  Install Aside Browser and sign in first (expected under ~/.aside)."
  }
  New-Item -ItemType Directory -Path $DestRoot | Out-Null
}

# Copy-AsideSkill SOURCE DEST [FORCE] REPO
# Full-tree copy. Kit-owned dest or old kit link → replace. Foreign → fail unless FORCE=1.
# Stages under a temp sibling + marker, then renames into place.
function Copy-AsideSkill {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Dest,
    [int]$Force = 0,
    [Parameter(Mandatory = $true)][string]$Repo
  )
  Require-SkillSource $Source
  $parent = Split-Path $Dest -Parent
  $name = Split-Path $Dest -Leaf
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    throw "destination parent missing: $parent"
  }
  $parent = Get-FullPathNormalized $parent
  $Dest = Join-Path $parent $name
  $sourceFull = Get-FullPathNormalized $Source

  if ((Test-Path -LiteralPath $Dest) -or (Test-ReparsePoint $Dest)) {
    if (-not (Test-AsideKitOwned $Dest $Repo $name) -and -not (Test-ExactLink $Dest $sourceFull) -and -not (Test-StaleKitPath $Dest $name)) {
      if ($Force -eq 1) {
        Write-Host "forced remove: $Dest"
      } else {
        throw "foreign path blocks install: $Dest`n  remove it manually, then re-run"
      }
    }
  }

  $tmp = Join-Path $parent ".$name.job-kit.$PID"
  $bak = Join-Path $parent ".$name.job-kit-bak.$PID"
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
  if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Recurse -Force }
  Copy-Item -LiteralPath $Source -Destination $tmp -Recurse
  [IO.File]::WriteAllText((Join-Path $tmp $script:AsideKitMarker), "$sourceFull`n")

  if ((Test-Path -LiteralPath $Dest) -or (Test-ReparsePoint $Dest)) {
    Rename-Item -LiteralPath $Dest -NewName (Split-Path $bak -Leaf)
    try {
      Rename-Item -LiteralPath $tmp -NewName $name
    } catch {
      Rename-Item -LiteralPath $bak -NewName $name -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
      throw "failed to replace $Dest"
    }
    Remove-KitLinkOrItem $bak
  } else {
    Rename-Item -LiteralPath $tmp -NewName $name
  }
  Write-Host "copied: $sourceFull -> $Dest"
}

# Unlink-AsideSkill DEST REPO NAME
# Removes DEST only when Test-AsideKitOwned.
function Unlink-AsideSkill {
  param(
    [Parameter(Mandatory = $true)][string]$Dest,
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if (-not (Test-Path -LiteralPath $Dest) -and -not (Test-ReparsePoint $Dest)) {
    Write-Host "skipped (missing): $Dest"
    return
  }
  if (-not (Test-AsideKitOwned $Dest $Repo $Name)) {
    Write-Host "skipped (not kit-owned): $Dest"
    return
  }
  try {
    Remove-KitLinkOrItem $Dest
  } catch {
    throw "failed to remove: $Dest : $($_.Exception.Message)"
  }
  Write-Host "removed: $Dest"
}

# Unlink-AsideLegacySkills DEST_ROOT REPO
# Removes DEST_ROOT/<legacy> when kit-owned (old symlink or marked copy).
function Unlink-AsideLegacySkills {
  param(
    [Parameter(Mandatory = $true)][string]$DestRoot,
    [Parameter(Mandatory = $true)][string]$Repo
  )
  foreach ($name in $script:AsideLegacySkillNames) {
    $dest = Get-SkillDest $DestRoot $name
    if (-not (Test-Path -LiteralPath $dest) -and -not (Test-ReparsePoint $dest)) {
      continue
    }
    if (Test-AsideKitOwned $dest $Repo $name) {
      try {
        Remove-KitLinkOrItem $dest
      } catch {
        throw "failed to remove legacy: $dest : $($_.Exception.Message)"
      }
      Write-Host "removed legacy: $dest"
    }
  }
}

# Remove-AsideLegacyUserSkills REPO [DEST_ROOT] [NAMES]
# Drop kit-owned current + legacy names under ~/.aside/u/<account>/skills/user.
# When DEST_ROOT is the same physical tree as skills/user, only remove legacy.
function Remove-AsideLegacyUserSkills {
  param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [string]$DestRoot = '',
    [string[]]$Names = $null
  )
  if ($null -eq $Names) { $Names = $script:AsideSkillNames }
  $account = '0'
  if ($env:ASIDE_ACCOUNT) { $account = $env:ASIDE_ACCOUNT }
  $userRoot = Join-Path $script:KitHome ".aside\u\$account\skills\user"
  if (-not (Test-Path -LiteralPath $userRoot -PathType Container)) {
    return
  }
  $userPhys = Resolve-PhysicalPath $userRoot
  if ($DestRoot -and (Test-Path -LiteralPath $DestRoot -PathType Container)) {
    $destPhys = Resolve-PhysicalPath $DestRoot
    if (Test-PathsEqual $userPhys $destPhys) {
      Unlink-AsideLegacySkills $userRoot $Repo
      Write-Host "skipped user skill migration: install dest is $userPhys"
      return
    }
  }
  Unlink-AsideLegacySkills $userRoot $Repo
  foreach ($name in $Names) {
    Unlink-AsideSkill (Get-SkillDest $userRoot $name) $Repo $name
  }
}

# Install-AsideSkillsInto DEST_ROOT REPO [FORCE]
# Ensure root, Copy-AsideSkill each AsideSkillNames, unlink legacy.
function Install-AsideSkillsInto {
  param(
    [Parameter(Mandatory = $true)][string]$DestRoot,
    [Parameter(Mandatory = $true)][string]$Repo,
    [int]$Force = 0
  )
  Ensure-AsideSkillsRoot $DestRoot
  foreach ($name in $script:AsideSkillNames) {
    $source = Get-SkillSource $Repo $name
    $dest = Get-SkillDest $DestRoot $name
    Copy-AsideSkill $source $dest $Force $Repo
  }
  Unlink-AsideLegacySkills $DestRoot $Repo
}
