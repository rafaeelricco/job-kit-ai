# job-kit installer router for Windows: interactive menu or target args.
# Windows PowerShell 5.1 and PowerShell 7. Local checkout only; no clone.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'agents\lib.ps1')
. (Join-Path $PSScriptRoot 'common.ps1')

$script:RepoRoot = Get-FullPathNormalized (Join-Path $PSScriptRoot '..')
$script:DryRunArgs = @()

function Show-InstallUsage {
  @'
Install job-kit skills (Aside + coding agents + browser-use).

Usage: install.ps1                 # interactive menu (console required)
       install.ps1 <target>...       # non-interactive (one or more targets)
       install.ps1 -h|--help

Targets:
  aside        Aside skills - full copy into the Aside skills root
  agents       Coding-agent skills (job-profile, job-list,
               job-match, job-stories, job-inbox, job-humanize,
               job-profile-root, job-store, job-resume-refine, job-resume-review)
  browser-use  Browser skills (job-scout, job-apply, job-prep) plus the browser-use
               driver skill into coding-agent homes; driven by the local
               browser-use CLI
  all          aside + agents + browser-use, skipping absent

Options:
  --dry-run     Print the plan, install nothing
  -h, --help    Show this help

This script only routes: each target runs its own installer, which prints its
own plan and confirms. On a console, confirm with [Y/n]; redirected stdin
applies after the plan. A foreign destination fails and names the path.

  aside        -> scripts\aside\install.ps1
  agents       -> scripts\agents\install.ps1
  browser-use  -> scripts\browser-use\install.ps1

Environment:
  CLAUDE_SKILLS  Absolute skills directory - single dest only (escape hatch)
  ASIDE_SKILLS / ASIDE_ACCOUNT
                 Same overrides as the Aside channel installer
  HOME           Absolute home (default %USERPROFILE%)
'@ | Write-Host
}

# Invoke-RunTarget TARGET
# Runs the channel installer. Never plans, copies, or links itself.
function Invoke-RunTarget {
  param([string]$Target)
  $installer = ''
  switch ($Target) {
    'aside' { $installer = Join-Path $script:RepoRoot 'scripts\aside\install.ps1' }
    'agents' { $installer = Join-Path $script:RepoRoot 'scripts\agents\install.ps1' }
    'browser-use' { $installer = Join-Path $script:RepoRoot 'scripts\browser-use\install.ps1' }
    default { Write-KitDie "unknown target: $Target" }
  }
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    Write-KitDie "channel installer missing: $installer"
  }
  $forward = @($script:DryRunArgs)
  # A child script only sets $LASTEXITCODE when it calls exit; seed it so a
  # clean return is not read as the previous command's code (or as unset
  # under Set-StrictMode).
  $global:LASTEXITCODE = 0
  & $installer @forward
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

# Invoke-RunAll
# Every channel whose parent exists. Absent is a skip, not a failure.
function Invoke-RunAll {
  $ran = $false
  if (Test-AsideReady) {
    Invoke-RunTarget 'aside'
    $ran = $true
  } else {
    $account = '0'
    if ($env:ASIDE_ACCOUNT) { $account = $env:ASIDE_ACCOUNT }
    Write-Host "Aside: not set up ($($script:KitHome)\.aside\u\$account\skills missing); skipping."
  }
  if (Test-AgentsReady) {
    Invoke-RunTarget 'agents'
    Invoke-RunTarget 'browser-use'
    $ran = $true
  } else {
    Write-Host 'Coding agents: no agent home (~/.claude, ~/.agents, ~/.grok, ~/.hermes); skipping.'
  }
  if (-not $ran) {
    Write-KitDie 'nothing installed: no Aside profile and no coding-agent home'
  }
}

function Invoke-InteractiveMenu {
  Write-Host '1. Aside skills'
  Write-Host '2. Coding-agent skills'
  Write-Host '3. browser-use skills (job-scout + job-apply + job-prep in coding agents)'
  Write-Host '4. All of the above'
  Write-Host '5. Quit'
  Write-Host -NoNewline 'Select component to install (number): '
  $choice = [Console]::In.ReadLine()
  if ($null -eq $choice) { $choice = '' }
  switch ($choice.Trim()) {
    '1' { Invoke-RunTarget 'aside' }
    '2' { Invoke-RunTarget 'agents' }
    '3' { Invoke-RunTarget 'browser-use' }
    '4' { Invoke-RunAll }
    '5' { Write-Host 'quit' }
    default {
      [Console]::Error.WriteLine('invalid choice')
      exit 1
    }
  }
}

function Invoke-InstallMain {
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
      '^-h$|^--help$' { Show-InstallUsage; exit 0 }
      '^--dry-run$' { $script:DryRunArgs = @('--dry-run') }
      '^aside$|^agents$|^browser-use$|^all$' { $targets.Add($a) | Out-Null }
      default { Write-KitDie "unknown option or target: $a (see --help)" }
    }
    $i++
  }

  if ($targets.Count -eq 0) {
    if (Test-IsConsoleInput) {
      Invoke-InteractiveMenu
      return
    }
    Write-KitDie 'need a target (aside|agents|browser-use|all) when stdin is not a console'
  }

  $hasAll = $false
  foreach ($t in $targets) {
    if ($t -eq 'all') { $hasAll = $true }
  }
  if ($hasAll) {
    if ($targets.Count -ne 1) { Write-KitDie "'all' cannot be combined with other targets" }
    Invoke-RunAll
    return
  }

  foreach ($t in $targets) {
    Invoke-RunTarget $t
  }
}

Invoke-InstallMain @($args)
