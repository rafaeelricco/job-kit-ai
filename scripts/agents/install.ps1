# Coding-agent channel installer for Windows: junctions kit skills into every
# agent home that exists. Windows PowerShell 5.1 and PowerShell 7.
# Local checkout only; no clone.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'lib.ps1')
. (Join-Path $PSScriptRoot '..\common.ps1')

$script:RepoRoot = Get-FullPathNormalized (Join-Path $PSScriptRoot '..\..')
$script:DryRun = 0
$script:Force = 0

function Show-AgentsUsage {
  @'
Install job-kit coding-agent skills (junctions into every agent home present).

Usage: agents\install.ps1 [--dry-run]
       agents\install.ps1 -h|--help

Options:
  --dry-run   Print the plan, link nothing
  -h, --help  Show this help

Homes: ~\.claude, ~\.agents, ~\.grok, ~\.hermes. Every one that exists is
installed; a missing home is skipped, not an error.

Every run prints a plan first. On a console, confirm with [Y/n]; redirected
stdin applies after the plan. A foreign destination fails and names the path -
remove it and re-run. Kit-owned destinations refresh.

Environment:
  CLAUDE_SKILLS  Absolute skills directory - single dest only (escape hatch)
  HOME           Absolute home (default %USERPROFILE%)
'@ | Write-Host
}

function Get-PlanRowsAgentHome {
  $rows = New-Object System.Collections.Generic.List[object]
  $names = $script:SkillNames

  try {
    $override = Resolve-OverrideSkills
  } catch {
    Write-KitDie $_.Exception.Message
  }
  if ($override) {
    $rows.Add((New-PlanRow 'H' 'agents (override)' $override)) | Out-Null
    foreach ($name in $names) {
      $source = Get-SkillSource $script:RepoRoot $name
      $dest = Get-SkillDest $override $name
      $rows.Add((New-PlanRowAgent $dest $name $source)) | Out-Null
    }
    return $rows
  }

  foreach ($target in $script:AgentTargets) {
    $root = Get-AgentSkillsRoot $target
    $agentLabel = Get-AgentLabel $target
    $parent = Get-AgentParentDir $target
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
      $rows.Add((New-PlanRow 'H' "agents - $agentLabel" $root)) | Out-Null
      $rows.Add((New-PlanRow 'N' 'parent missing' $parent)) | Out-Null
      continue
    }
    $rows.Add((New-PlanRow 'H' "agents - $agentLabel" $root)) | Out-Null
    foreach ($name in $names) {
      $source = Get-SkillSource $script:RepoRoot $name
      $dest = Get-SkillDest $root $name
      $rows.Add((New-PlanRowAgent $dest $name $source)) | Out-Null
    }
  }
  return $rows
}

function Install-AgentHome {
  $names = $script:SkillNames
  try {
    $override = Resolve-OverrideSkills
  } catch {
    Write-KitDie $_.Exception.Message
  }
  if ($override) {
    Write-Host "== override ($override) =="
    try {
      Install-SkillsInto $override $script:RepoRoot $names
    } catch {
      Write-KitDie $_.Exception.Message
    }
    Write-Host "Install completed -> $override"
    return
  }

  $linked = 0
  $attempted = 0
  foreach ($target in $script:AgentTargets) {
    $parent = Get-AgentParentDir $target
    $destRoot = Get-AgentSkillsRoot $target
    $agentLabel = Get-AgentLabel $target
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
      Write-Host "${agentLabel}: parent missing ($parent); skipping."
      continue
    }
    $attempted++
    Write-Host "== $agentLabel ($destRoot) =="
    try {
      Install-SkillsInto $destRoot $script:RepoRoot $names
      $linked++
    } catch {
      Write-KitDie $_.Exception.Message
    }
  }
  try {
    Remove-LegacyCodexSkillsDir $script:RepoRoot
  } catch {
    Write-KitDie $_.Exception.Message
  }
  if ($linked -eq 0) {
    Write-KitDie "no agent targets installed (need parent dirs or CLAUDE_SKILLS)`n  expected one of: ~/.claude  ~/.agents  ~/.grok  ~/.hermes"
  }
  Write-Host "Install completed ($linked/$attempted targets)"
}

function Invoke-AgentsPlan {
  if (-not (Test-Path -LiteralPath (Join-Path $script:RepoRoot 'skill') -PathType Container)) {
    Write-KitDie "not a job-kit checkout (missing skill/): $($script:RepoRoot)"
  }

  $rows = @(Get-PlanRowsAgentHome)
  Write-Plan $rows
  $installs = Get-PlanCount $rows @('I')
  Write-Host "$installs installs"
  Write-Host ''

  $installs += Resolve-PlanBlockers $rows

  if ($script:DryRun -eq 1) {
    Write-Host '--dry-run: nothing has been touched.'
    return
  }

  if ($installs -eq 0) {
    $hasParentMissing = $false
    $hasUpToDate = $false
    foreach ($row in $rows) {
      if ($row.Label -eq 'parent missing') { $hasParentMissing = $true }
      if ($row.Label -eq 'up to date') { $hasUpToDate = $true }
    }
    if ($hasParentMissing -and -not $hasUpToDate) {
      Write-KitDie 'nothing to install: required parent directories are missing (see plan)'
    }
    Write-Host 'nothing to install.'
    return
  }

  if (-not (Confirm-Plan $installs)) { exit 1 }
  Write-Host ''
  Write-Host 'applying'
  Install-AgentHome
  Write-Host ''
  Write-Host "done - $installs installs - 0 failed"
}

function Invoke-AgentsMain {
  param([string[]]$Argv = @())
  if ($null -eq $Argv) { $Argv = @() }

  if ($env:HOME -match "`r|`n") { Write-KitDie 'HOME must not contain a line break' }
  if ($env:CLAUDE_SKILLS -match "`r|`n") { Write-KitDie 'CLAUDE_SKILLS must not contain a line break' }

  $i = 0
  while ($i -lt $Argv.Count) {
    $a = $Argv[$i]
    switch -Regex ($a) {
      '^-h$|^--help$' { Show-AgentsUsage; exit 0 }
      '^--dry-run$' { $script:DryRun = 1 }
      default { Write-KitDie "unknown option: $a (see --help)" }
    }
    $i++
  }

  Invoke-AgentsPlan
}

Invoke-AgentsMain @($args)
