# Shared helpers for coding-agent skill install/uninstall on Windows.
# Source only — do not execute. Windows PowerShell 5.1 and PowerShell 7.

$script:CoreSkillNames = @(
  'job-profile-root',
  'job-store'
)
$script:SkillNames = @(
  'job-profile',
  'job-list',
  'job-match',
  'job-stories',
  'job-inbox',
  'job-outreach',
  'job-humanize',
  'job-resume-refine'
) + $script:CoreSkillNames
$script:BrowserSkillNames = @('job-scout', 'job-apply', 'job-prep')
$script:BrowserSharedDeps = @(
  'job-match',
  'job-list',
  'job-profile',
  'job-resume-refine',
  'job-humanize',
  'captcha-solver'
) + $script:CoreSkillNames
$script:BrowserLegacySkillNames = @('job-resume')
$script:LegacySkillNames = @('profile-init', 'job-profile-config', 'job-tracker', 'job-resume', 'job-profile-init', 'job-profile-me', 'job-pitch', 'job-captcha-solver')
$script:AllSkillNames = $script:SkillNames + $script:BrowserSkillNames + $script:BrowserSharedDeps
$script:AgentTargets = @('claude', 'codex', 'grok', 'hermes')
$script:AgentsOnlyNames = @('job-stories', 'job-inbox', 'job-outreach')

# Get-FullPathNormalized PATH
# Absolute path, trailing slashes removed (a lone drive root keeps its slash).
function Get-FullPathNormalized {
  param([Parameter(Mandatory = $true)][string]$Path)
  $full = [IO.Path]::GetFullPath($Path)
  if ($full.Length -gt 3) {
    $full = $full.TrimEnd('\')
  }
  return $full
}

# Test-RootedPath PATH — true when PATH is an absolute Windows path.
function Test-RootedPath {
  param([string]$Path)
  if (-not $Path) { return $false }
  return [IO.Path]::IsPathRooted($Path)
}

# Get-KitUserHome
# USERPROFILE analog of Unix HOME. Honors $env:HOME when it is rooted (Git Bash).
function Get-KitUserHome {
  $h = $null
  if ($env:HOME -and [IO.Path]::IsPathRooted($env:HOME)) {
    $h = $env:HOME
  } else {
    $h = $env:USERPROFILE
  }
  if (-not $h -or -not [IO.Path]::IsPathRooted($h)) {
    throw "HOME must be an absolute path (got: $h)"
  }
  if ($h -match "`r|`n") {
    throw "HOME must not contain a line break"
  }
  return (Get-FullPathNormalized $h)
}

$script:KitHome = Get-KitUserHome

# Get-JobKitHomePath
# Cached checkout: $env:JOB_KIT_HOME, else $XDG_DATA_HOME\job-kit, else ~\.local\share\job-kit.
function Get-JobKitHomePath {
  if ($env:JOB_KIT_HOME) {
    if ($env:JOB_KIT_HOME -match "`r|`n") {
      throw "JOB_KIT_HOME must not contain a line break"
    }
    if (-not (Test-RootedPath $env:JOB_KIT_HOME)) {
      throw "JOB_KIT_HOME must be an absolute path (got: $($env:JOB_KIT_HOME))"
    }
    return (Get-FullPathNormalized $env:JOB_KIT_HOME)
  }
  if ($env:XDG_DATA_HOME) {
    if ($env:XDG_DATA_HOME -match "`r|`n") {
      throw "XDG_DATA_HOME must not contain a line break"
    }
    if (-not (Test-RootedPath $env:XDG_DATA_HOME)) {
      throw "XDG_DATA_HOME must be an absolute path (got: $($env:XDG_DATA_HOME))"
    }
    return (Join-Path (Get-FullPathNormalized $env:XDG_DATA_HOME) 'job-kit')
  }
  return (Join-Path $script:KitHome '.local\share\job-kit')
}

# Test-PathsEqual A B — same physical path, case-insensitive.
function Test-PathsEqual {
  param([string]$A, [string]$B)
  if (-not $A -or -not $B) { return $false }
  return ((Get-FullPathNormalized $A) -ieq (Get-FullPathNormalized $B))
}

# Test-HasCommand NAME — true when NAME is on PATH.
function Test-HasCommand {
  param([Parameter(Mandatory = $true)][string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# Test-ReparsePoint PATH — true when PATH is a junction or symlink (incl. dangling).
function Test-ReparsePoint {
  param([Parameter(Mandatory = $true)][string]$Path)
  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  } catch {
    return $false
  }
  return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

# Get-LinkTarget PATH
# Normalized target of a junction/symlink, or $null. Strips the NT `\??\` prefix.
function Get-LinkTarget {
  param([Parameter(Mandatory = $true)][string]$Path)
  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  } catch {
    return $null
  }
  if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    return $null
  }
  $t = $item.Target
  if ($null -eq $t) { return $null }
  if ($t -is [System.Array]) {
    if ($t.Length -eq 0) { return $null }
    $t = $t[0]
  }
  $t = [string]$t
  if ($t.StartsWith('\??\')) {
    $t = $t.Substring(4)
  }
  if (-not $t) { return $null }
  # A symlink made with a relative target (mklink /D LINK ..\dir) stores that
  # text verbatim; anchor it to the link's parent, not the process CWD.
  if (-not [IO.Path]::IsPathRooted($t)) {
    $t = Join-Path (Split-Path $item.FullName -Parent) $t
  }
  try {
    return (Get-FullPathNormalized $t)
  } catch {
    return $t.TrimEnd('\')
  }
}

# Resolve-PhysicalPath PATH
# Physical directory PATH names, following junctions/symlinks (bounded), then
# normalized. `[IO.Path]::GetFullPath` is lexical and never resolves a reparse
# point, so deleting through it would only drop the alias and leave the target.
function Resolve-PhysicalPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  $cur = Get-FullPathNormalized $Path
  for ($i = 0; $i -lt 32 -and (Test-ReparsePoint $cur); $i++) {
    $target = Get-LinkTarget $cur
    if (-not $target) { break }
    $cur = $target
  }
  return $cur
}

# Remove-KitLinkOrItem PATH
# Junction/symlink: delete the reparse point only (never walk into the target).
# Real directory: recursive delete. File: delete.
function Remove-KitLinkOrItem {
  param([Parameter(Mandatory = $true)][string]$Path)
  $item = $null
  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  } catch {
    return
  }
  $isReparse = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
  if ($isReparse) {
    if ($item.PSIsContainer) {
      [IO.Directory]::Delete($item.FullName)
    } else {
      [IO.File]::Delete($item.FullName)
    }
    return
  }
  if ($item.PSIsContainer) {
    Remove-Item -LiteralPath $item.FullName -Recurse -Force
  } else {
    Remove-Item -LiteralPath $item.FullName -Force
  }
}

# Resolve-RepoRoot
# Absolute job-kit root (parent of scripts/). Uses this file's directory.
function Resolve-RepoRoot {
  $scriptsDir = Split-Path $PSScriptRoot -Parent
  $repo = Split-Path $scriptsDir -Parent
  if (-not (Test-Path -LiteralPath (Join-Path $repo 'skill') -PathType Container)) {
    throw "not a job-kit checkout (missing skill/): $repo"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $repo 'scripts\agents') -PathType Container)) {
    throw "not a job-kit checkout (missing scripts/agents/): $repo"
  }
  return (Get-FullPathNormalized $repo)
}

# Resolve-OverrideSkills
# Absolute CLAUDE_SKILLS when set. Empty string if unset. Throws if set but not rooted.
function Resolve-OverrideSkills {
  if (-not $env:CLAUDE_SKILLS) {
    return ''
  }
  if ($env:CLAUDE_SKILLS -match "`r|`n") {
    throw "CLAUDE_SKILLS must not contain a line break"
  }
  if (-not (Test-RootedPath $env:CLAUDE_SKILLS)) {
    throw "CLAUDE_SKILLS must be an absolute path"
  }
  return (Get-FullPathNormalized $env:CLAUDE_SKILLS)
}

# Get-AgentSkillsRoot TARGET
function Get-AgentSkillsRoot {
  param([Parameter(Mandatory = $true)][string]$Target)
  switch ($Target) {
    'claude' { return (Join-Path $script:KitHome '.claude\skills') }
    'codex'  { return (Join-Path $script:KitHome '.agents\skills') }
    'grok'   { return (Join-Path $script:KitHome '.grok\skills') }
    'hermes' { return (Join-Path $script:KitHome '.hermes\skills') }
    default {
      throw "unknown agent target: $Target"
    }
  }
}

# Get-AgentParentDir TARGET
function Get-AgentParentDir {
  param([Parameter(Mandatory = $true)][string]$Target)
  return (Split-Path (Get-AgentSkillsRoot $Target) -Parent)
}

# Get-AgentLabel TARGET
function Get-AgentLabel {
  param([Parameter(Mandatory = $true)][string]$Target)
  switch ($Target) {
    'claude' { return 'Claude Code' }
    'codex'  { return 'Codex' }
    'grok'   { return 'Grok' }
    'hermes' { return 'Hermes Agent' }
    default { return $Target }
  }
}

# Get-SkillSource REPO NAME
function Get-SkillSource {
  param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$Name
  )
  return (Join-Path $Repo "skill\$Name")
}

# Get-SkillDest ROOT NAME
function Get-SkillDest {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Name
  )
  return (Join-Path $Root $Name)
}

# Test-ExactLink DEST SOURCE
function Test-ExactLink {
  param(
    [Parameter(Mandatory = $true)][string]$Dest,
    [Parameter(Mandatory = $true)][string]$Source
  )
  if (-not (Test-ReparsePoint $Dest)) { return $false }
  $current = Get-LinkTarget $Dest
  if (-not $current) { return $false }
  return (Test-PathsEqual $current $Source)
}

# Test-KitSkillLink DEST REPO NAME
function Test-KitSkillLink {
  param(
    [Parameter(Mandatory = $true)][string]$Dest,
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$Name
  )
  return (Test-ExactLink $Dest (Get-SkillSource $Repo $Name))
}

# Get-AgentsNamesForRoot ROOT REPO
# SkillNames minus BrowserSharedDeps when ROOT still has a browser-channel kit link.
function Get-AgentsNamesForRoot {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Repo
  )
  foreach ($n in $script:BrowserSkillNames) {
    if (Test-KitSkillLink (Get-SkillDest $Root $n) $Repo $n) {
      $out = New-Object System.Collections.Generic.List[string]
      foreach ($name in $script:SkillNames) {
        if ($script:BrowserSharedDeps -contains $name) { continue }
        $out.Add($name) | Out-Null
      }
      return $out.ToArray()
    }
  }
  return $script:SkillNames
}

# Require-SkillSource SOURCE
function Require-SkillSource {
  param([Parameter(Mandatory = $true)][string]$Source)
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    throw "skill source missing: $Source"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $Source 'SKILL.md') -PathType Leaf)) {
    throw "skill missing SKILL.md: $Source"
  }
}

# Ensure-SkillsDir DEST_ROOT
# Creates DEST_ROOT only if its parent already exists (agent home already set up).
function Ensure-SkillsDir {
  param([Parameter(Mandatory = $true)][string]$DestRoot)
  if (Test-Path -LiteralPath $DestRoot -PathType Container) {
    return
  }
  $parent = Split-Path $DestRoot -Parent
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    throw "coding-agent skills parent missing: $parent`n  Open the agent once, mkdir the parent, or set CLAUDE_SKILLS."
  }
  New-Item -ItemType Directory -Path $DestRoot | Out-Null
}

# Link-Skill SOURCE DEST
# Idempotent directory junction. Exact → no-op. Any other existing path → fail.
function Link-Skill {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Dest
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

  if (Test-ExactLink $Dest $sourceFull) {
    Write-Host "up to date: $Dest"
    return
  }

  if ((Test-Path -LiteralPath $Dest) -or (Test-ReparsePoint $Dest)) {
    if ($script:Force -ne 1 -and -not (Test-StaleKitPath $Dest $name)) {
      throw "foreign path blocks install: $Dest`n  remove it manually, then re-run"
    }
    Remove-KitLinkOrItem $Dest
    Write-Host "replaced: $Dest"
  }

  try {
    New-Item -ItemType Junction -Path $Dest -Target $sourceFull | Out-Null
  } catch {
    throw "failed to link $Dest -> $sourceFull : $($_.Exception.Message)"
  }
  Write-Host "linked: $Dest -> $sourceFull"
}

# Unlink-Skill DEST REPO NAME
# Removes DEST only when it is a kit-owned skill link for NAME.
function Unlink-Skill {
  param(
    [Parameter(Mandatory = $true)][string]$Dest,
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if (-not (Test-Path -LiteralPath $Dest) -and -not (Test-ReparsePoint $Dest)) {
    Write-Host "skipped (missing): $Dest"
    return
  }
  if (-not (Test-KitSkillLink $Dest $Repo $Name)) {
    Write-Host "skipped (not kit link): $Dest"
    return
  }
  try {
    Remove-KitLinkOrItem $Dest
  } catch {
    throw "failed to remove: $Dest : $($_.Exception.Message)"
  }
  Write-Host "removed: $Dest"
}

# Unlink-LegacySkills DEST_ROOT REPO
function Unlink-LegacySkills {
  param(
    [Parameter(Mandatory = $true)][string]$DestRoot,
    [Parameter(Mandatory = $true)][string]$Repo
  )
  foreach ($name in $script:LegacySkillNames) {
    $dest = Get-SkillDest $DestRoot $name
    if (-not (Test-Path -LiteralPath $dest) -and -not (Test-ReparsePoint $dest)) {
      continue
    }
    if (Test-KitSkillLink $dest $Repo $name) {
      try {
        Remove-KitLinkOrItem $dest
      } catch {
        throw "failed to remove legacy link: $dest : $($_.Exception.Message)"
      }
      Write-Host "removed legacy: $dest"
    }
  }
}

# Install-SkillsInto DEST_ROOT REPO [NAMES]
function Install-SkillsInto {
  param(
    [Parameter(Mandatory = $true)][string]$DestRoot,
    [Parameter(Mandatory = $true)][string]$Repo,
    [string[]]$Names = $null
  )
  if ($null -eq $Names) { $Names = $script:SkillNames }
  Ensure-SkillsDir $DestRoot
  foreach ($name in $Names) {
    $source = Get-SkillSource $Repo $name
    $dest = Get-SkillDest $DestRoot $name
    Link-Skill $source $dest
  }
  Unlink-LegacySkills $DestRoot $Repo
}

# Uninstall-SkillsFrom DEST_ROOT REPO [NAMES]
function Uninstall-SkillsFrom {
  param(
    [Parameter(Mandatory = $true)][string]$DestRoot,
    [Parameter(Mandatory = $true)][string]$Repo,
    [string[]]$Names = $null
  )
  if ($null -eq $Names) { $Names = $script:SkillNames }
  Unlink-LegacySkills $DestRoot $Repo
  foreach ($name in $Names) {
    $dest = Get-SkillDest $DestRoot $name
    Unlink-Skill $dest $Repo $name
  }
}

# Remove-LegacyCodexSkillsDir REPO
function Remove-LegacyCodexSkillsDir {
  param([Parameter(Mandatory = $true)][string]$Repo)
  $legacyRoot = Join-Path $script:KitHome '.codex\skills'
  if (-not (Test-Path -LiteralPath $legacyRoot) -and -not (Test-ReparsePoint $legacyRoot)) {
    return
  }
  foreach ($name in ($script:AllSkillNames + $script:LegacySkillNames)) {
    $dest = Get-SkillDest $legacyRoot $name
    if (Test-KitSkillLink $dest $Repo $name) {
      try {
        Remove-KitLinkOrItem $dest
      } catch {
        throw "failed to remove legacy Codex path: $dest : $($_.Exception.Message)"
      }
      Write-Host "removed legacy Codex path: $dest"
    }
  }
}

# Test-AgentsHomeOwned ROOT REPO
# True when this home still has an agents-only kit link (shared-deps keep).
function Test-AgentsHomeOwned {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Repo
  )
  foreach ($n in $script:AgentsOnlyNames) {
    if (Test-KitSkillLink (Get-SkillDest $Root $n) $Repo $n) {
      return $true
    }
  }
  return $false
}

$script:WorkerAgentSource = 'skill/job-match/agents/job-kit-worker.md'
$script:WorkerAgentMarker = '# job-kit: managed copy'

# Get-WorkerAgentDest
# The Claude Code agent file path.
function Get-WorkerAgentDest {
  return (Join-Path (Join-Path (Join-Path (Get-KitUserHome) '.claude') 'agents') 'job-kit-worker.md')
}

# Test-WorkerAgentMarked PATH
# True when PATH is a regular file carrying the kit marker line.
function Test-WorkerAgentMarked {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or (Test-ReparsePoint $Path)) { return $false }
  return [bool](Select-String -LiteralPath $Path -SimpleMatch -Pattern $script:WorkerAgentMarker -Quiet)
}

# Test-WorkerAgentSame SOURCE DEST
# True when both files exist and are byte-identical.
function Test-WorkerAgentSame {
  param([string]$Source, [string]$Dest)
  if (-not (Test-Path -LiteralPath $Dest -PathType Leaf)) { return $false }
  $a = [IO.File]::ReadAllBytes($Source)
  $b = [IO.File]::ReadAllBytes($Dest)
  if ($a.Length -ne $b.Length) { return $false }
  for ($i = 0; $i -lt $a.Length; $i++) {
    if ($a[$i] -ne $b[$i]) { return $false }
  }
  return $true
}

# New-PlanRowWorkerAgent REPO
# N source missing | N up to date | I copy | I refresh | N foreign.
function New-PlanRowWorkerAgent {
  param([Parameter(Mandatory = $true)][string]$Repo)
  $source = Join-Path $Repo $script:WorkerAgentSource
  $dest = Get-WorkerAgentDest
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    return (New-PlanRow 'N' 'source missing' $dest)
  }
  if (Test-WorkerAgentSame $source $dest) {
    return (New-PlanRow 'N' 'up to date' $dest)
  }
  if (-not (Test-Path -LiteralPath $dest) -and -not (Test-ReparsePoint $dest)) {
    return (New-PlanRow 'I' 'copy' $dest)
  }
  if (Test-WorkerAgentMarked $dest) {
    return (New-PlanRow 'I' 'refresh' $dest)
  }
  return (New-PlanRow 'N' 'foreign' $dest)
}

# Copy-WorkerAgent REPO
# Copy the agent file into ~/.claude/agents. Copies when absent, refreshes a marked
# copy, replaces an unmarked file only when Force is 1.
function Copy-WorkerAgent {
  param([Parameter(Mandatory = $true)][string]$Repo)
  $source = Join-Path $Repo $script:WorkerAgentSource
  $dest = Get-WorkerAgentDest
  $parent = Split-Path $dest -Parent
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "agent source missing: $source"
  }
  $claudeHome = Split-Path $parent -Parent
  if (-not (Test-Path -LiteralPath $claudeHome -PathType Container)) {
    throw "destination parent missing: $claudeHome"
  }
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  if (Test-WorkerAgentSame $source $dest) {
    Write-Host "up to date: $dest"
    return
  }
  if ((Test-Path -LiteralPath $dest) -or (Test-ReparsePoint $dest)) {
    if (Test-WorkerAgentMarked $dest) {
      # kit-owned copy: refresh below
    } elseif ($script:Force -eq 1) {
      Remove-KitLinkOrItem $dest
      Write-Host "forced remove: $dest"
    } else {
      throw "foreign path blocks install: $dest`n  remove it manually, then re-run"
    }
  }
  try {
    Copy-Item -LiteralPath $source -Destination $dest -Force
  } catch {
    throw "failed to copy ${dest}: $($_.Exception.Message)"
  }
  Write-Host "copied: $dest"
}

# Remove-WorkerAgent
# Removes the copy only when it carries the kit marker.
function Remove-WorkerAgent {
  $dest = Get-WorkerAgentDest
  if (-not (Test-Path -LiteralPath $dest) -and -not (Test-ReparsePoint $dest)) {
    Write-Host "skipped (missing): $dest"
    return
  }
  if (-not (Test-WorkerAgentMarked $dest)) {
    Write-Host "skipped (not kit copy): $dest"
    return
  }
  try {
    Remove-Item -LiteralPath $dest -Force
  } catch {
    throw "failed to remove: $dest : $($_.Exception.Message)"
  }
  Write-Host "removed: $dest"
}
