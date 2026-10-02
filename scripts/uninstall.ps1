# Single job-kit uninstaller for Windows: interactive menu or target args.
# Agents + Aside + browser-use + profile + cache.
# Windows PowerShell 5.1 and PowerShell 7.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'agents\lib.ps1')
. (Join-Path $PSScriptRoot 'aside\lib.ps1')
. (Join-Path $PSScriptRoot 'common.ps1')

$script:RepoRoot = Get-FullPathNormalized (Join-Path $PSScriptRoot '..')
$script:JobKitHome = Get-JobKitHomePath
$script:DryRun = 0
$script:UninstallTargets = @()

$script:KitOwnershipFiles = @(
  'scripts\agents\install.sh',
  'scripts\agents\lib.sh',
  'scripts\aside\install.sh',
  'scripts\aside\lib.sh',
  'skill\job-profile\SKILL.md',
  'skill\job-scout\SKILL.md'
)

function Show-UninstallUsage {
  @'
Uninstall job-kit (Windows: aside + agents + browser-use + profile + cache).

Usage: uninstall.ps1                 # interactive menu (console required)
       uninstall.ps1 <target>...       # non-interactive (one or more targets)
       uninstall.ps1 -h|--help

Targets:
  aside        Aside skills (job-scout, job-apply, job-prep, job-resume-refine, job-profile, job-list, job-match, job-stories, job-inbox, job-outreach, job-humanize, job-profile-root, job-store)
  agents       Coding-agent skills (job-profile, job-list,
               job-match, job-stories, job-inbox, job-outreach, job-humanize,
               job-profile-root, job-store, job-resume-refine)
  browser-use  Browser skills (job-scout, job-apply, job-prep) in coding-agent homes, plus
               the browser-use driver: its skill, its CLI, its state directory.
               Never a browser app
  profile      Delete profile root(s) + matching profile-root pointer
  cache        Remove kit checkout cache (JOB_KIT_HOME), kit-owned only
  all          aside + agents + browser-use + profile + cache

Options:
  --dry-run     Print the plan, run every guard, remove nothing
  -h, --help    Show this help

Every run prints a plan first. A plan holding profile or cache data requires
typing yes; anything re-installable takes [Y/n]. On redirected stdin,
re-installable targets apply after the plan and profile/cache refuse.

Profile path: $XDG_CONFIG_HOME\job-kit when set, otherwise %USERPROFILE%\.config\job-kit.

Environment:
  JOB_KIT_HOME   Kit cache (default $XDG_DATA_HOME\job-kit or ~\.local\share\job-kit)
  ASIDE_SKILLS / ASIDE_ACCOUNT / CLAUDE_SKILLS
                 Same overrides as the channel installers
'@ | Write-Host
}

function Get-JobKitConfig {
  if ($env:XDG_CONFIG_HOME) {
    if ($env:XDG_CONFIG_HOME -match "`r|`n") {
      Write-KitDie 'XDG_CONFIG_HOME must not contain a line break'
    }
    if (-not (Test-RootedPath $env:XDG_CONFIG_HOME)) {
      Write-KitDie "XDG_CONFIG_HOME must be an absolute path (got: $($env:XDG_CONFIG_HOME)); unset it to use the host default"
    }
    return (Join-Path (Get-FullPathNormalized $env:XDG_CONFIG_HOME) 'job-kit')
  }
  return (Join-Path $script:KitHome '.config\job-kit')
}

function Get-HostDefaultRoot {
  return (Join-Path $script:KitHome '.config\job-kit')
}

function Get-BrowserHarnessState {
  if ($env:XDG_CONFIG_HOME) {
    if ($env:XDG_CONFIG_HOME -match "`r|`n") {
      Write-KitDie 'XDG_CONFIG_HOME must not contain a line break'
    }
    if (-not (Test-RootedPath $env:XDG_CONFIG_HOME)) {
      Write-KitDie "XDG_CONFIG_HOME must be an absolute path (got: $($env:XDG_CONFIG_HOME)); unset it to use the host default"
    }
    return (Join-Path (Get-FullPathNormalized $env:XDG_CONFIG_HOME) 'browser-harness')
  }
  return (Join-Path $script:KitHome '.config\browser-harness')
}

function Get-ProfilePointerFile {
  return (Join-Path $script:KitHome '.config\profile-root')
}

function Read-ProfilePointer {
  param([string]$File)
  if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return '' }
  $line = ([IO.File]::ReadAllText($File) -replace "`r|`n", '').Trim()
  if (-not $line) { return '' }
  if (-not (Test-RootedPath $line)) {
    Write-KitDie "profile-root pointer $File must be an absolute path (got: $line)"
  }
  return $line
}

function Get-ProfileDeleteCandidates {
  $out = New-Object System.Collections.Generic.List[string]
  $out.Add((Get-JobKitConfig)) | Out-Null
  $out.Add((Get-HostDefaultRoot)) | Out-Null
  $ptr = Read-ProfilePointer (Get-ProfilePointerFile)
  if ($ptr) { $out.Add($ptr) | Out-Null }
  return $out.ToArray()
}

function Get-ResolvePhysical {
  param([string]$Path)
  $head = $Path.TrimEnd('\')
  if ($head.Length -eq 2 -and $head[1] -eq ':') { $head = $head + '\' }
  $tail = ''
  while ($head.Length -gt 3 -and -not (Test-Path -LiteralPath $head -PathType Container)) {
    $leaf = Split-Path $head -Leaf
    $tail = '\' + $leaf + $tail
    $parent = Split-Path $head -Parent
    if (-not $parent -or $parent -ieq $head) { break }
    $head = $parent
  }
  if (Test-Path -LiteralPath $head -PathType Container) {
    try { $head = Resolve-PhysicalPath $head } catch { }
  }
  if ($head.EndsWith('\') -and $head.Length -eq 3) {
    return ($head.TrimEnd('\') + $tail)
  }
  return ($head + $tail)
}

function Test-PathContains {
  param([string]$Ancestor, [string]$Descendant)
  $a = $Ancestor.TrimEnd('\')
  $b = $Descendant.TrimEnd('\')
  if ($a.Length -eq 2 -and $a[1] -eq ':') {
    return $b.StartsWith(($a + '\'), [StringComparison]::OrdinalIgnoreCase)
  }
  $prefix = $a + '\'
  return $b.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Test-PathsOverlap {
  param([string]$A, [string]$B)
  $a = Get-ResolvePhysical $A
  $b = Get-ResolvePhysical $B
  if ($a -ieq $b) { return $true }
  if (Test-PathContains $a $b) { return $true }
  if (Test-PathContains $b $a) { return $true }
  return $false
}

function Assert-ProfilePath {
  param([string]$Path)
  if (Test-PathsOverlap $Path $script:RepoRoot) {
    Write-KitDie "refusing to delete profile root overlapping the executing checkout: $Path (checkout: $($script:RepoRoot))"
  }
  $cache = $script:JobKitHome
  if (Test-Path -LiteralPath $script:JobKitHome -PathType Container) {
    try { $cache = Resolve-PhysicalPath $script:JobKitHome } catch { $cache = $script:JobKitHome }
  }
  if ((Test-PathsOverlap $Path $script:JobKitHome) -or (Test-PathsOverlap $Path $cache)) {
    Write-KitDie "refusing to delete profile root overlapping the kit cache: $Path (cache: $cache)"
  }
}

function Get-ProfileProbeMissing {
  param([string]$Dir)
  foreach ($rel in @('data\candidate.yaml', 'data\job_search.yaml')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Dir $rel) -PathType Leaf)) {
      return ($rel -replace '\\', '/')
    }
  }
  return ''
}

# Get-OwnedByRoot PATH NAME ROOTS [-LinkOnly]
# Returns PATH when it is a skill link, or a marked copy, whose source is
# ROOT\skill\NAME for any ROOT given — the two forms scripts/uninstall.sh:680-683
# reads. -LinkOnly drops the copy form for callers whose apply step requires a
# link (Unlink-Skill -> Test-ExactLink, scripts/agents/lib.ps1:277).
function Get-OwnedByRoot {
  param([string]$Path, [string]$Name, [string[]]$Roots, [switch]$LinkOnly)
  if (Test-ReparsePoint $Path) {
    $current = Get-LinkTarget $Path
    if (-not $current) { return $null }
    foreach ($root in $Roots) {
      $expected = Get-SkillSource $root $Name
      if (Test-PathsEqual $current $expected) { return $Path }
    }
    return $null
  }
  if ($LinkOnly) { return $null }
  # Test-KitSkillCopy owns the marker read (aside/lib.ps1:38) — one reader, so a
  # copy is judged here exactly as the mutators judge it.
  foreach ($root in $Roots) {
    if (Test-KitSkillCopy $Path $root $Name) { return $Path }
  }
  return $null
}

function New-UninstallSkillRow {
  param([string]$Dest, [string]$Name, [string]$Tag)
  # -LinkOnly: agents and browser-use rows apply through Unlink-Skill, which
  # requires a link, so a marked copy under those roots must not be promised.
  $hit = Get-OwnedByRoot $Dest $Name @($script:RepoRoot) -LinkOnly
  if ($hit) {
    return (New-PlanRow 'I' "remove link ($Tag)" $Dest)
  }
  if ((Test-Path -LiteralPath $Dest) -or (Test-ReparsePoint $Dest)) {
    return (New-PlanRow 'N' 'not kit-owned' $Dest)
  }
  if ($Tag -eq 'current') {
    return (New-PlanRow 'N' 'not installed' $Dest)
  }
  return $null
}

function New-UninstallAsideSkillRow {
  param([string]$Dest, [string]$Name, [string]$Tag)
  if (Test-AsideKitOwned $Dest $script:RepoRoot $Name) {
    return (New-PlanRow 'I' "remove copy ($Tag)" $Dest)
  }
  if ((Test-Path -LiteralPath $Dest) -or (Test-ReparsePoint $Dest)) {
    return (New-PlanRow 'N' 'not kit-owned' $Dest)
  }
  if ($Tag -eq 'current') {
    return (New-PlanRow 'N' 'not installed' $Dest)
  }
  return $null
}

function Get-PlanRowsAside {
  $destRoot = Resolve-AsideSkillsRoot
  $rows = New-Object System.Collections.Generic.List[object]
  $rows.Add((New-PlanRow 'H' 'aside' $destRoot)) | Out-Null
  foreach ($name in $script:AsideLegacySkillNames) {
    $row = New-UninstallAsideSkillRow (Get-SkillDest $destRoot $name) $name 'legacy'
    if ($row) { $rows.Add($row) | Out-Null }
  }
  foreach ($name in $script:AsideSkillNames) {
    $row = New-UninstallAsideSkillRow (Get-SkillDest $destRoot $name) $name 'current'
    if ($row) { $rows.Add($row) | Out-Null }
  }
  $account = '0'
  if ($env:ASIDE_ACCOUNT) { $account = $env:ASIDE_ACCOUNT }
  $userRoot = Join-Path $script:KitHome ".aside\u\$account\skills\user"
  if (-not (Test-Path -LiteralPath $userRoot -PathType Container)) {
    return $rows
  }
  $rows.Add((New-PlanRow 'H' 'aside (legacy user root)' $userRoot)) | Out-Null
  foreach ($name in $script:AsideLegacySkillNames) {
    $row = New-UninstallAsideSkillRow (Get-SkillDest $userRoot $name) $name 'legacy'
    if ($row) { $rows.Add($row) | Out-Null }
  }
  # Same physical tree as dest (ASIDE_SKILLS override): legacy only, skip current.
  $sameTree = $false
  if (Test-Path -LiteralPath $destRoot -PathType Container) {
    $userPhys = Resolve-PhysicalPath $userRoot
    $destPhys = Resolve-PhysicalPath $destRoot
    if (Test-PathsEqual $userPhys $destPhys) { $sameTree = $true }
  } elseif (Test-PathsEqual $userRoot $destRoot) {
    $sameTree = $true
  }
  if ($sameTree) { return $rows }
  foreach ($name in $script:AsideSkillNames) {
    $row = New-UninstallAsideSkillRow (Get-SkillDest $userRoot $name) $name 'current'
    if ($row) { $rows.Add($row) | Out-Null }
  }
  return $rows
}

function Uninstall-Aside {
  $destRoot = Resolve-AsideSkillsRoot
  Write-Host "== job-kit Aside uninstall for $destRoot =="
  Unlink-AsideLegacySkills $destRoot $script:RepoRoot
  foreach ($name in $script:AsideSkillNames) {
    Unlink-AsideSkill (Get-SkillDest $destRoot $name) $script:RepoRoot $name
  }
  Remove-AsideLegacyUserSkills $script:RepoRoot $destRoot $script:AsideSkillNames
  Write-Host "Uninstall completed for $destRoot"
}

# New-PlanRowWorkerAgentRemoval
# I remove copy | N not kit-owned | N not installed.
function New-PlanRowWorkerAgentRemoval {
  $dest = Get-WorkerAgentDest
  if (Test-WorkerAgentMarked $dest) {
    return (New-PlanRow 'I' 'remove copy' $dest)
  }
  if ((Test-Path -LiteralPath $dest) -or (Test-ReparsePoint $dest)) {
    return (New-PlanRow 'N' 'not kit-owned' $dest)
  }
  return (New-PlanRow 'N' 'not installed' $dest)
}

function Get-PlanRowsAgents {
  $rows = New-Object System.Collections.Generic.List[object]
  try {
    $override = Resolve-OverrideSkills
  } catch {
    Write-KitDie $_.Exception.Message
  }
  if ($override) {
    $rows.Add((New-PlanRow 'H' 'agents (override)' $override)) | Out-Null
    $names = $script:LegacySkillNames + @(Get-AgentsNamesForRoot $override $script:RepoRoot)
    foreach ($name in $names) {
      $row = New-UninstallSkillRow (Get-SkillDest $override $name) $name 'current'
      if ($row) { $rows.Add($row) | Out-Null }
    }
    return $rows
  }
  foreach ($target in $script:AgentTargets) {
    $root = Get-AgentSkillsRoot $target
    $label = Get-AgentLabel $target
    $parent = Get-AgentParentDir $target
    if (-not (Test-Path -LiteralPath $parent -PathType Container) -and -not (Test-Path -LiteralPath $root -PathType Container)) {
      $rows.Add((New-PlanRow 'N' 'nothing to uninstall' $root)) | Out-Null
      continue
    }
    $rows.Add((New-PlanRow 'H' "agents - $label" $root)) | Out-Null
    foreach ($name in $script:LegacySkillNames) {
      $row = New-UninstallSkillRow (Get-SkillDest $root $name) $name 'legacy'
      if ($row) { $rows.Add($row) | Out-Null }
    }
    foreach ($name in @(Get-AgentsNamesForRoot $root $script:RepoRoot)) {
      $row = New-UninstallSkillRow (Get-SkillDest $root $name) $name 'current'
      if ($row) { $rows.Add($row) | Out-Null }
    }
    if ($target -eq 'claude') {
      $rows.Add((New-PlanRowWorkerAgentRemoval)) | Out-Null
    }
  }
  $legacyRoot = Join-Path $script:KitHome '.codex\skills'
  if ((Test-Path -LiteralPath $legacyRoot) -or (Test-ReparsePoint $legacyRoot)) {
    $rows.Add((New-PlanRow 'H' 'agents (legacy Codex root)' $legacyRoot)) | Out-Null
    foreach ($name in ($script:SkillNames + $script:LegacySkillNames)) {
      $row = New-UninstallSkillRow (Get-SkillDest $legacyRoot $name) $name 'legacy'
      if ($row) { $rows.Add($row) | Out-Null }
    }
  }
  return $rows
}

function Add-BrowserSharedDepRows {
  param([object]$Rows, [string]$PlanRoot)
  if ($script:UninstallTargets -contains 'agents') {
    foreach ($pname in $script:BrowserSharedDeps) {
      $row = New-UninstallSkillRow (Get-SkillDest $PlanRoot $pname) $pname 'current'
      if ($row) { $Rows.Add($row) | Out-Null }
    }
    return
  }
  $agentsOwned = Test-AgentsHomeOwned $PlanRoot $script:RepoRoot
  foreach ($pname in $script:BrowserSharedDeps) {
    if ($agentsOwned -and ($script:SkillNames -contains $pname)) { continue }
    $row = New-UninstallSkillRow (Get-SkillDest $PlanRoot $pname) $pname 'current'
    if ($row) { $Rows.Add($row) | Out-Null }
  }
}

function Get-PlanRowsBrowserUse {
  $rows = New-Object System.Collections.Generic.List[object]
  $state = Get-BrowserHarnessState
  try {
    $override = Resolve-OverrideSkills
  } catch {
    Write-KitDie $_.Exception.Message
  }

  if ($override) {
    $rows.Add((New-PlanRow 'H' 'browser-use (override)' $override)) | Out-Null
    foreach ($name in $script:BrowserSkillNames) {
      $row = New-UninstallSkillRow (Get-SkillDest $override $name) $name 'current'
      if ($row) { $rows.Add($row) | Out-Null }
    }
    foreach ($name in $script:BrowserLegacySkillNames) {
      $row = New-UninstallSkillRow (Get-SkillDest $override $name) $name 'legacy'
      if ($row) { $rows.Add($row) | Out-Null }
    }
    Add-BrowserSharedDepRows $rows $override
  } else {
    foreach ($target in $script:AgentTargets) {
      $root = Get-AgentSkillsRoot $target
      $label = Get-AgentLabel $target
      $parent = Get-AgentParentDir $target
      if (-not (Test-Path -LiteralPath $parent -PathType Container) -and -not (Test-Path -LiteralPath $root -PathType Container)) {
        $rows.Add((New-PlanRow 'N' 'nothing to uninstall' $root)) | Out-Null
        continue
      }
      $rows.Add((New-PlanRow 'H' "browser-use - $label" $root)) | Out-Null
      foreach ($name in $script:BrowserSkillNames) {
        $row = New-UninstallSkillRow (Get-SkillDest $root $name) $name 'current'
        if ($row) { $rows.Add($row) | Out-Null }
      }
      foreach ($name in $script:BrowserLegacySkillNames) {
        $row = New-UninstallSkillRow (Get-SkillDest $root $name) $name 'legacy'
        if ($row) { $rows.Add($row) | Out-Null }
      }
      Add-BrowserSharedDepRows $rows $root
    }
  }

  $rows.Add((New-PlanRow 'H' 'browser-use - driver (not kit-owned)' 'browser-use')) | Out-Null
  if ($override) {
    $dest = Join-Path $override 'browser-use'
    if ((Test-Path -LiteralPath $dest) -or (Test-ReparsePoint $dest)) {
      $rows.Add((New-PlanRow 'I' 'remove driver' $dest)) | Out-Null
    }
  }
  foreach ($target in $script:AgentTargets) {
    $root = Get-AgentSkillsRoot $target
    $dest = Join-Path $root 'browser-use'
    if ($override -and (Test-PathsEqual $dest (Join-Path $override 'browser-use'))) { continue }
    if (-not (Test-Path -LiteralPath $dest) -and -not (Test-ReparsePoint $dest)) {
      continue
    }
    $rows.Add((New-PlanRow 'I' 'remove driver' $dest)) | Out-Null
  }
  if (Test-HasCommand 'browser-use') {
    $bin = (Get-Command 'browser-use').Source
    $rows.Add((New-PlanRow 'I' 'remove CLI' $bin)) | Out-Null
  }
  if (Test-Path -LiteralPath $state -PathType Container) {
    $rows.Add((New-PlanRow 'I' 'remove state' $state)) | Out-Null
  }
  $rows.Add((New-PlanRow 'N' 'left installed' 'Google Chrome (this kit never removes a browser)')) | Out-Null
  return $rows
}

function Get-PlanRowsProfile {
  $rows = New-Object System.Collections.Generic.List[object]
  $existing = New-Object System.Collections.Generic.List[string]
  $rows.Add((New-PlanRow 'H' 'profile' (Get-JobKitConfig))) | Out-Null
  foreach ($path in @(Get-ProfileDeleteCandidates)) {
    if (-not $path) { continue }
    if (-not (Test-Path -LiteralPath $path) -and -not (Test-ReparsePoint $path)) { continue }
    if ((Test-ReparsePoint $path) -and (Test-Path -LiteralPath $path -PathType Container)) {
      $rows.Add((New-PlanRow 'X' 'remove alias' $path)) | Out-Null
      $path = Resolve-PhysicalPath $path
    }
    $seen = $false
    foreach ($e in $existing) {
      if (Test-PathsEqual $e $path) { $seen = $true; break }
    }
    if ($seen) { continue }
    $existing.Add($path) | Out-Null
    $rows.Add((New-PlanRow 'X' 'DELETE TREE' $path)) | Out-Null
  }
  if ($existing.Count -eq 0) {
    $rows.Add((New-PlanRow 'N' 'already absent' (Get-JobKitConfig))) | Out-Null
  }
  $pointer = Get-ProfilePointerFile
  if (Test-Path -LiteralPath $pointer -PathType Leaf) {
    $rows.Add((New-PlanRow 'I' 'clear pointer' $pointer)) | Out-Null
  } else {
    $rows.Add((New-PlanRow 'N' 'pointer absent' $pointer)) | Out-Null
  }
  return $rows
}

function Get-PlanRowsCache {
  $rows = New-Object System.Collections.Generic.List[object]
  $raw = $script:JobKitHome
  $rows.Add((New-PlanRow 'H' 'cache' $raw)) | Out-Null
  if (-not (Test-Path -LiteralPath $raw) -and -not (Test-ReparsePoint $raw)) {
    $rows.Add((New-PlanRow 'N' 'already absent' $raw)) | Out-Null
    return $rows
  }
  $dest = $raw
  if (Test-ReparsePoint $raw) {
    $dest = Resolve-PhysicalPath $raw
  } elseif (Test-Path -LiteralPath $raw -PathType Container) {
    $dest = Resolve-PhysicalPath $raw
  }
  $rows.Add((New-PlanRow 'X' 'PURGE CACHE' $dest)) | Out-Null
  if (Test-ReparsePoint $raw) {
    $rows.Add((New-PlanRow 'X' 'remove alias' $raw)) | Out-Null
  }
  return $rows
}

function Get-BuildPlan {
  param([string[]]$Targets)
  $rows = New-Object System.Collections.Generic.List[object]
  foreach ($t in $Targets) {
    switch ($t) {
      'aside' { foreach ($r in (Get-PlanRowsAside)) { $rows.Add($r) | Out-Null } }
      'agents' { foreach ($r in (Get-PlanRowsAgents)) { $rows.Add($r) | Out-Null } }
      'browser-use' { foreach ($r in (Get-PlanRowsBrowserUse)) { $rows.Add($r) | Out-Null } }
      'profile' { foreach ($r in (Get-PlanRowsProfile)) { $rows.Add($r) | Out-Null } }
      'cache' { foreach ($r in (Get-PlanRowsCache)) { $rows.Add($r) | Out-Null } }
    }
  }
  return $rows
}

function Confirm-UninstallPlan {
  param([int]$Removals, [int]$Irreversible)
  if ($Irreversible -gt 0) {
    return (Confirm-TypedYes 'Proceed? Profile/cache data cannot be recovered. Type yes: ')
  }
  Write-Host -NoNewline "Proceed? $Removals removals, all re-installable. [Y/n] "
  $answer = [Console]::In.ReadLine()
  if ($null -eq $answer) { $answer = '' }
  switch -Regex ($answer.Trim()) {
    '^$|^y$|^Y$|^yes$' { return $true }
    default {
      [Console]::Error.WriteLine('aborted.')
      return $false
    }
  }
}

function Uninstall-Agents {
  try {
    $override = Resolve-OverrideSkills
  } catch {
    Write-KitDie $_.Exception.Message
  }
  Write-Host '== job-kit agents uninstall =='
  if ($override) {
    Write-Host "== override ($override) =="
    try {
      Uninstall-SkillsFrom $override $script:RepoRoot @(Get-AgentsNamesForRoot $override $script:RepoRoot)
    } catch {
      Write-KitDie $_.Exception.Message
    }
    Write-Host "Uninstall completed for $override"
    return
  }
  foreach ($target in $script:AgentTargets) {
    $parent = Get-AgentParentDir $target
    $destRoot = Get-AgentSkillsRoot $target
    $label = Get-AgentLabel $target
    if (-not (Test-Path -LiteralPath $parent -PathType Container) -and -not (Test-Path -LiteralPath $destRoot -PathType Container)) {
      Write-Host "${label}: nothing to uninstall ($destRoot)."
      continue
    }
    Write-Host "== $label ($destRoot) =="
    try {
      Uninstall-SkillsFrom $destRoot $script:RepoRoot @(Get-AgentsNamesForRoot $destRoot $script:RepoRoot)
      if ($target -eq 'claude') {
        Remove-WorkerAgent
      }
    } catch {
      Write-KitDie $_.Exception.Message
    }
  }
  try {
    Remove-LegacyCodexSkillsDir $script:RepoRoot
  } catch {
    Write-KitDie $_.Exception.Message
  }
  Write-Host 'Uninstall completed'
}

function Unlink-BrowserSkillsFrom {
  param([string]$Root)
  foreach ($n in ($script:BrowserSkillNames + $script:BrowserLegacySkillNames)) {
    Unlink-Skill (Get-SkillDest $Root $n) $script:RepoRoot $n
  }
  $agentsOwned = Test-AgentsHomeOwned $Root $script:RepoRoot
  foreach ($n in $script:BrowserSharedDeps) {
    if ($agentsOwned -and ($script:SkillNames -contains $n)) { continue }
    Unlink-Skill (Get-SkillDest $Root $n) $script:RepoRoot $n
  }
}

function Remove-DriverDest {
  param([string]$Dest)
  if (-not (Test-Path -LiteralPath $Dest) -and -not (Test-ReparsePoint $Dest)) {
    Write-Host "skipped (missing): $Dest"
    return
  }
  try {
    if (Test-ReparsePoint $Dest) {
      Remove-KitLinkOrItem $Dest
    } else {
      Remove-Item -LiteralPath $Dest -Recurse -Force
    }
  } catch {
    Write-KitDie "failed to remove driver skill: $Dest"
  }
  Write-Host "removed driver skill: $Dest"
}

function Uninstall-BrowserUse {
  $state = Get-BrowserHarnessState
  try {
    $override = Resolve-OverrideSkills
  } catch {
    Write-KitDie $_.Exception.Message
  }
  $cliFailed = $false
  Write-Host '== job-kit browser-use uninstall =='
  if ($override) {
    Write-Host "== override ($override) =="
    try {
      Unlink-BrowserSkillsFrom $override
    } catch {
      Write-KitDie $_.Exception.Message
    }
    Write-Host "Uninstall completed for $override"
  } else {
    foreach ($target in $script:AgentTargets) {
      $parent = Get-AgentParentDir $target
      $destRoot = Get-AgentSkillsRoot $target
      $label = Get-AgentLabel $target
      if (-not (Test-Path -LiteralPath $parent -PathType Container) -and -not (Test-Path -LiteralPath $destRoot -PathType Container)) {
        Write-Host "${label}: nothing to uninstall ($destRoot)."
        continue
      }
      Write-Host "== $label ($destRoot) =="
      try {
        Unlink-BrowserSkillsFrom $destRoot
      } catch {
        Write-KitDie $_.Exception.Message
      }
    }
  }

  Write-Host '== browser-use - driver (not kit-owned) =='
  if ($override) {
    Remove-DriverDest (Join-Path $override 'browser-use')
  }
  foreach ($target in $script:AgentTargets) {
    $dest = Join-Path (Get-AgentSkillsRoot $target) 'browser-use'
    if ($override -and (Test-PathsEqual $dest (Join-Path $override 'browser-use'))) { continue }
    Remove-DriverDest $dest
  }
  if (Test-HasCommand 'browser-use') {
    if (Test-HasCommand 'uv') {
      & uv tool uninstall browser-use
      if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        [Console]::Error.WriteLine('error: uv tool uninstall browser-use failed; remove it yourself')
        $cliFailed = $true
      }
    } else {
      $bin = (Get-Command 'browser-use').Source
      [Console]::Error.WriteLine("error: browser-use CLI left installed (uv not found): $bin")
      $cliFailed = $true
    }
  }
  if (Test-Path -LiteralPath $state -PathType Container) {
    try {
      Remove-Item -LiteralPath $state -Recurse -Force
    } catch {
      Write-KitDie "failed to remove driver state: $state"
    }
    Write-Host "removed driver state: $state"
  }
  Write-Host 'Google Chrome left installed (uninstall it yourself if you want it gone).'
  if ($cliFailed) { exit 1 }
  Write-Host 'Uninstall completed'
}

function Assert-ProfileInputs {
  $null = Get-JobKitConfig
  $null = Get-HostDefaultRoot
  foreach ($root in @((Get-JobKitConfig), (Get-HostDefaultRoot))) {
    if (-not (Test-ReparsePoint $root)) { continue }
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
    $target = Resolve-PhysicalPath $root
    $missing = Get-ProfileProbeMissing $target
    if ($missing) {
      Write-KitDie @"
refusing to delete profile root ${root}: it is a symlink to $target
missing or unreadable: $missing (a symlinked root is only an alias; its target must be a profile)
delete $target yourself, or remove the link
"@
    }
  }
  $file = Get-ProfilePointerFile
  $path = Read-ProfilePointer $file
  if ($path) {
    if ((Test-Path -LiteralPath $path) -or (Test-ReparsePoint $path)) {
      if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        Write-KitDie "refusing to delete profile root named by ${file}: not a directory: $path"
      }
      $missing = Get-ProfileProbeMissing $path
      if ($missing) {
        Write-KitDie @"
refusing to delete profile root named by ${file}: $path
missing or unreadable: $missing (the probe activation requires before writing that pointer)
fix or remove the pointer, or delete $path yourself
"@
      }
    }
  }
}

function Clear-PointerIfMatches {
  param([string]$File, [string[]]$Paths)
  if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return }
  $line = ([IO.File]::ReadAllText($File) -replace "`r|`n", '').Trim()
  if (-not $line) {
    Remove-Item -LiteralPath $File -Force
    Write-Host "removed empty pointer: $File"
    return
  }
  $canon = ''
  if (Test-Path -LiteralPath $line -PathType Container) {
    $canon = Get-FullPathNormalized $line
  }
  foreach ($p in $Paths) {
    if ($line -ieq $p) {
      Remove-Item -LiteralPath $File -Force
      Write-Host "removed pointer: $File"
      return
    }
    if ($canon -and (Test-Path -LiteralPath $p -PathType Container) -and (Test-PathsEqual $canon $p)) {
      Remove-Item -LiteralPath $File -Force
      Write-Host "removed pointer: $File"
      return
    }
    if ($canon -and ($canon -ieq $p)) {
      Remove-Item -LiteralPath $File -Force
      Write-Host "removed pointer: $File"
      return
    }
  }
}

function Remove-Profile {
  Assert-ProfileInputs
  $config = Get-JobKitConfig
  $hostDefault = Get-HostDefaultRoot
  $existing = New-Object System.Collections.Generic.List[string]
  $clearArgs = New-Object System.Collections.Generic.List[string]
  $aliases = New-Object System.Collections.Generic.List[string]

  foreach ($path in @(Get-ProfileDeleteCandidates)) {
    if (-not $path) { continue }
    $clearArgs.Add($path) | Out-Null
    if (-not (Test-Path -LiteralPath $path) -and -not (Test-ReparsePoint $path)) { continue }
    if ((Test-ReparsePoint $path) -and (Test-Path -LiteralPath $path -PathType Container)) {
      $aliases.Add($path) | Out-Null
      $path = Resolve-PhysicalPath $path
    }
    $seen = $false
    foreach ($e in $existing) {
      if (Test-PathsEqual $e $path) { $seen = $true; break }
    }
    if ($seen) { continue }
    Assert-ProfilePath $path
    $existing.Add($path) | Out-Null
  }

  if ($existing.Count -eq 0) {
    Write-Host "profile: already absent ($config"
    if (-not (Test-PathsEqual $config $hostDefault)) {
      Write-Host "  and $hostDefault"
    }
    Write-Host ')'
  } else {
    Write-Host 'profile paths to delete:'
    foreach ($path in $existing) { Write-Host "  $path" }
    # No prompt here: Confirm-UninstallPlan already took the typed yes for the
    # whole plan, and it is the only gate.
    foreach ($path in $existing) {
      try {
        if (Test-ReparsePoint $path) {
          Remove-KitLinkOrItem $path
        } else {
          Remove-Item -LiteralPath $path -Recurse -Force
        }
      } catch {
        Write-KitDie "failed to remove profile: $path"
      }
      Write-Host "removed profile: $path"
    }
    foreach ($path in $aliases) {
      if ((Test-ReparsePoint $path) -and -not (Test-Path -LiteralPath $path)) {
        try { Remove-KitLinkOrItem $path } catch { Write-KitDie "failed to remove profile alias: $path" }
        Write-Host "removed profile alias: $path"
      }
    }
  }
  if ($clearArgs.Count -gt 0) {
    Clear-PointerIfMatches (Get-ProfilePointerFile) @($clearArgs.ToArray())
  }
}

function Get-KitOwnedMissing {
  param([string]$Dir)
  $skill = Join-Path $Dir 'skill'
  if ((Test-ReparsePoint $skill) -or -not (Test-Path -LiteralPath $skill -PathType Container)) {
    return 'skill/'
  }
  foreach ($rel in $script:KitOwnershipFiles) {
    $cur = $Dir
    foreach ($part in ($rel -split '\\')) {
      $cur = Join-Path $cur $part
      if (Test-ReparsePoint $cur) { return ($rel -replace '\\', '/') }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Dir $rel) -PathType Leaf)) {
      $init = Join-Path $Dir 'skill\job-profile-init\SKILL.md'
      if ($rel -eq 'skill\job-profile\SKILL.md' `
        -and -not (Test-ReparsePoint (Join-Path $Dir 'skill\job-profile-init')) `
        -and -not (Test-ReparsePoint $init) `
        -and (Test-Path -LiteralPath $init -PathType Leaf)) {
        continue
      }
      return ($rel -replace '\\', '/')
    }
  }
  return ''
}

function Get-LinksOwnedBy {
  param([string]$Dest, [string]$Scope = 'all')
  $phys = $Dest
  if (Test-Path -LiteralPath $Dest -PathType Container) {
    try { $phys = Resolve-PhysicalPath $Dest } catch { $phys = $Dest }
  }
  $found = New-Object System.Collections.Generic.List[string]
  $override = ''
  try { $override = Resolve-OverrideSkills } catch { }

  function script:Add-ScanRoot {
    param([string]$R)
    foreach ($n in ($script:AllSkillNames + $script:LegacySkillNames)) {
      $p = Get-SkillDest $R $n
      $hit = Get-OwnedByRoot $p $n @($Dest, $phys)
      if ($hit) { $found.Add($hit) | Out-Null }
    }
  }

  function script:Add-AsideScanRoot {
    param([string]$R)
    foreach ($n in ($script:AsideSkillNames + $script:AsideLegacySkillNames)) {
      $p = Get-SkillDest $R $n
      $hit = Get-OwnedByRoot $p $n @($Dest, $phys)
      if ($hit) { $found.Add($hit) | Out-Null }
    }
  }

  if ($override) { script:Add-ScanRoot $override }

  foreach ($target in $script:AgentTargets) {
    $root = Get-AgentSkillsRoot $target
    $skipScan = $false
    if ($Scope -eq 'survivors' -and -not $override) {
      $skipScan = $true
    }
    if (-not $skipScan) { script:Add-ScanRoot $root }
  }
  $legacy = Join-Path $script:KitHome '.codex\skills'
  if ($Scope -ne 'survivors' -or $override) {
    script:Add-ScanRoot $legacy
  }

  # Aside copies point at the cache too (scripts/uninstall.sh:1224-1293). Read
  # ASIDE_SKILLS raw rather than via Resolve-AsideSkillsRoot: that throws on a bad
  # override (aside/lib.ps1:23,26) and a scan must not abort the uninstaller.
  $asideOverride = ''
  if ($env:ASIDE_SKILLS -and (Test-RootedPath $env:ASIDE_SKILLS)) {
    $asideOverride = $env:ASIDE_SKILLS
    script:Add-AsideScanRoot $asideOverride
  }
  $account = '0'
  if ($env:ASIDE_ACCOUNT) { $account = $env:ASIDE_ACCOUNT }
  $accountsRoot = Join-Path $script:KitHome '.aside\u'
  if (Test-Path -LiteralPath $accountsRoot -PathType Container) {
    # Every account is walked, not just ASIDE_ACCOUNT: skills installed under
    # another account outlive a purge run without it. GetDirectories returns
    # hidden entries, so a dot-prefixed account id is covered.
    $accountDirs = @()
    try { $accountDirs = [IO.Directory]::GetDirectories($accountsRoot) } catch { $accountDirs = @() }
    foreach ($dir in $accountDirs) {
      # scope=survivors: Uninstall-Aside reaches only ASIDE_ACCOUNT, so every
      # other account survives it. An override sends the unlink phase to that
      # root instead, so skills\builtin is not covered by the exemption;
      # Remove-AsideLegacyUserSkills clears skills\user either way.
      if ($Scope -eq 'survivors' -and (Split-Path $dir -Leaf) -eq $account) {
        if ($asideOverride) { script:Add-AsideScanRoot (Join-Path $dir 'skills\builtin') }
        continue
      }
      script:Add-AsideScanRoot (Join-Path $dir 'skills\builtin')
      script:Add-AsideScanRoot (Join-Path $dir 'skills\user')
    }
  }
  return $found.ToArray()
}

function Invoke-PurgePreflight {
  param([string]$Scope = 'all')
  $raw = $script:JobKitHome
  if (-not (Test-Path -LiteralPath $raw) -and -not (Test-ReparsePoint $raw)) {
    return
  }
  $dest = $raw
  if (Test-Path -LiteralPath $raw -PathType Container) {
    $dest = Resolve-PhysicalPath $raw
  }
  $missing = Get-KitOwnedMissing $dest
  if ($missing) {
    Write-KitDie "refusing to start: the cache purge would fail on a non-kit path (missing $missing): $dest"
  }
  if (-not (Test-PathsEqual $dest (Resolve-PhysicalPath $script:RepoRoot))) {
    $Scope = 'all'
  }
  $outstanding = @(Get-LinksOwnedBy $raw $Scope)
  if ($outstanding.Count -gt 0) {
    $list = $outstanding -join "`n"
    Write-KitDie "refusing to start: installed skills point at $dest and this run will not remove them:`n$list`nuninstall those skills first, or run the uninstaller from $dest"
  }
}

function Remove-Cache {
  $raw = $script:JobKitHome
  if (-not (Test-Path -LiteralPath $raw) -and -not (Test-ReparsePoint $raw)) {
    Write-Host "cache already absent: $raw"
    return
  }
  $dest = $raw
  if (Test-Path -LiteralPath $raw -PathType Container) {
    $dest = Resolve-PhysicalPath $raw
  }
  $missing = Get-KitOwnedMissing $dest
  if ($missing) {
    Write-KitDie "refusing to purge non-kit path (missing $missing): $dest"
  }
  $outstanding = @(Get-LinksOwnedBy $raw)
  if ($outstanding.Count -gt 0) {
    $list = $outstanding -join "`n"
    Write-KitDie "refusing to purge ${dest}: these still point at it, or could not be inspected:`n$list`nuninstall those skills first ('uninstall.ps1 aside agents browser-use', or 'all')"
  }
  # No prompt here: Confirm-UninstallPlan already took the typed yes for the
  # whole plan, and it is the only gate.
  try {
    if (Test-ReparsePoint $dest) {
      Remove-KitLinkOrItem $dest
    } else {
      Remove-Item -LiteralPath $dest -Recurse -Force
    }
  } catch {
    Write-KitDie "failed to remove cache: $dest"
  }
  if ((Test-ReparsePoint $raw) -and -not (Test-PathsEqual $raw $dest)) {
    try { Remove-KitLinkOrItem $raw } catch { Write-KitDie "failed to remove cache symlink: $raw" }
  }
  Write-Host "purged cache: $dest"
}

function Invoke-PlanPreflight {
  param([string[]]$Targets)
  foreach ($t in $Targets) {
    if ($t -eq 'agents' -or $t -eq 'browser-use') {
      try { $null = Resolve-OverrideSkills } catch { Write-KitDie "refusing to start: the $t target cannot resolve its skills root" }
      if ($t -eq 'browser-use') { $null = Get-BrowserHarnessState }
    } elseif ($t -eq 'profile') {
      Assert-ProfileInputs
    }
  }
}

function Invoke-PreflightTargets {
  param([string[]]$Targets)
  foreach ($t in $Targets) {
    if ($t -eq 'profile') {
      Assert-ProfileInputs
      foreach ($root in @(Get-ProfileDeleteCandidates)) {
        if (-not $root) { continue }
        Assert-ProfilePath $root
      }
    }
  }
}

function Invoke-RunTarget {
  param([string]$Target)
  switch ($Target) {
    'aside' { Uninstall-Aside }
    'agents' { Uninstall-Agents }
    'browser-use' { Uninstall-BrowserUse }
    'profile' { Remove-Profile }
    'cache' { Remove-Cache }
    default { Write-KitDie "unknown target: $Target (aside|agents|browser-use|profile|cache|all)" }
  }
}

function Get-PlanOrder {
  param([string[]]$Targets)
  $hasCache = $false
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($t in $Targets) {
    if ($t -eq 'cache') { $hasCache = $true; continue }
    if ($out -contains $t) { continue }
    $out.Add($t) | Out-Null
  }
  if ($hasCache) { $out.Add('cache') | Out-Null }
  return $out.ToArray()
}

function Invoke-RunPlan {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Targets)
  $ordered = @(Get-PlanOrder $Targets)
  if ($ordered.Count -eq 0) { Write-KitDie 'no targets selected' }
  $script:UninstallTargets = $ordered
  $seenAside = $ordered -contains 'aside'
  $seenAgents = $ordered -contains 'agents'
  $seenBrowser = $ordered -contains 'browser-use'
  $hasCache = $ordered -contains 'cache'

  Invoke-PlanPreflight $ordered
  $rows = @(Get-BuildPlan $ordered)
  Write-Plan $rows -Irreversible
  $removals = Get-PlanCount $rows @('I', 'X')
  $irreversible = Get-PlanCount $rows @('X')
  Write-Host "$removals removals - $irreversible irreversible"
  Write-Host ''

  Invoke-PreflightTargets $ordered
  if ($hasCache) {
    $scope = 'all'
    # All three: the survivor scan enumerates both name unions, and only these
    # targets unlink them. Without aside, an agents+browser+cache run would
    # exempt an Aside root nothing has removed.
    if ($seenAside -and $seenAgents -and $seenBrowser) { $scope = 'survivors' }
    Invoke-PurgePreflight $scope
  }

  if ($script:DryRun -eq 1) {
    Write-Host '--dry-run: nothing has been touched.'
    return
  }
  if ($removals -eq 0) {
    Write-Host 'nothing to remove.'
    return
  }
  if (-not (Confirm-UninstallPlan $removals $irreversible)) { exit 1 }
  Write-Host ''
  Write-Host 'applying'
  foreach ($t in $ordered) {
    Invoke-RunTarget $t
  }
  Write-Host ''
  Write-Host "done - $removals removals - 0 failed"
}

function Invoke-InteractiveMenu {
  Write-Host '1. Aside skills'
  Write-Host '2. Coding-agent skills'
  Write-Host '3. browser-use skills + driver'
  Write-Host '4. Profile data (~/.config/job-kit)'
  Write-Host '5. Kit cache (JOB_KIT_HOME)'
  Write-Host '6. All of the above'
  Write-Host '7. Quit'
  Write-Host -NoNewline 'Select component to uninstall (number): '
  $choice = [Console]::In.ReadLine()
  if ($null -eq $choice) { $choice = '' }
  switch ($choice.Trim()) {
    '1' { Invoke-RunPlan 'aside' }
    '2' { Invoke-RunPlan 'agents' }
    '3' { Invoke-RunPlan 'browser-use' }
    '4' { Invoke-RunPlan 'profile' }
    '5' { Invoke-RunPlan 'cache' }
    '6' { Invoke-RunPlan 'aside' 'agents' 'browser-use' 'profile' 'cache' }
    '7' { Write-Host 'quit' }
    default {
      [Console]::Error.WriteLine('invalid choice')
      exit 1
    }
  }
}

function Invoke-UninstallMain {
  param([string[]]$Argv = @())
  if ($null -eq $Argv) { $Argv = @() }

  if ($env:HOME -match "`r|`n") { Write-KitDie 'HOME must not contain a line break' }
  if ($env:CLAUDE_SKILLS -match "`r|`n") { Write-KitDie 'CLAUDE_SKILLS must not contain a line break' }
  if ($env:ASIDE_SKILLS -match "`r|`n") { Write-KitDie 'ASIDE_SKILLS must not contain a line break' }
  if ($env:ASIDE_ACCOUNT -match "`r|`n") { Write-KitDie 'ASIDE_ACCOUNT must not contain a line break' }

  $targets = New-Object System.Collections.Generic.List[string]
  $i = 0
  while ($i -lt $Argv.Count) {
    $a = $Argv[$i]
    switch -Regex ($a) {
      '^-h$|^--help$' { Show-UninstallUsage; exit 0 }
      '^--dry-run$' { $script:DryRun = 1 }
      '^aside$|^agents$|^browser-use$|^profile$|^cache$|^all$' { $targets.Add($a) | Out-Null }
      default { Write-KitDie "unknown option or target: $a (see --help)" }
    }
    $i++
  }

  if ($targets.Count -eq 0) {
    if (Test-IsConsoleInput) {
      Invoke-InteractiveMenu
      return
    }
    Write-KitDie 'need a target (aside|agents|browser-use|profile|cache|all) when stdin is not a console'
  }

  $hasAll = $false
  foreach ($t in $targets) {
    if ($t -eq 'all') { $hasAll = $true }
  }
  if ($hasAll) {
    if ($targets.Count -ne 1) { Write-KitDie "'all' cannot be combined with other targets" }
    Invoke-RunPlan 'aside' 'agents' 'browser-use' 'profile' 'cache'
    return
  }
  Invoke-RunPlan @($targets.ToArray())
}

Invoke-UninstallMain @($args)
