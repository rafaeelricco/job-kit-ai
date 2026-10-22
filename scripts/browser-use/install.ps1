# Browser channel installer for Windows: browser skills plus the browser-use
# driver skill into coding-agent homes, reusing the agents junction mechanics.
# Windows PowerShell 5.1 and PowerShell 7. Local checkout only; no clone.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..\agents\lib.ps1')
. (Join-Path $PSScriptRoot '..\common.ps1')

$script:RepoRoot = Get-FullPathNormalized (Join-Path $PSScriptRoot '..\..')
$script:DryRun = 0
$script:Force = 0

function Show-BrowserUseUsage {
  @'
Install job-kit browser skills plus the browser-use driver skill.

Usage: browser-use\install.ps1 [--dry-run]
       browser-use\install.ps1 -h|--help

Options:
  --dry-run   Print the plan, link nothing
  -h, --help  Show this help

Links job-company-scout, job-scout, job-apply and job-prep (with their shared dependencies) into
every coding-agent home present, then offers the browser-use CLI, a Chromium
browser, and the driver skill for anything still missing.

Every run prints a plan first. On a console, confirm with [Y/n]; redirected
stdin applies after the plan. A foreign destination fails and names the path -
remove it and re-run. Kit-owned destinations refresh.

Environment:
  CLAUDE_SKILLS  Absolute skills directory - single dest only (escape hatch)
  HOME           Absolute home (default %USERPROFILE%)
'@ | Write-Host
}

function Test-Chromium {
  $rels = @(
    'Google\Chrome\Application\chrome.exe',
    'Google\Chrome SxS\Application\chrome.exe',
    'Chromium\Application\chrome.exe',
    'BraveSoftware\Brave-Browser\Application\brave.exe',
    'Microsoft\Edge\Application\msedge.exe',
    'Arc\Application\Arc.exe'
  )
  $roots = New-Object System.Collections.Generic.List[string]
  if ($env:ProgramFiles) { $roots.Add($env:ProgramFiles) | Out-Null }
  $pf86 = ${env:ProgramFiles(x86)}
  if ($pf86) { $roots.Add($pf86) | Out-Null }
  if ($env:LOCALAPPDATA) { $roots.Add($env:LOCALAPPDATA) | Out-Null }
  foreach ($root in $roots) {
    foreach ($rel in $rels) {
      if (Test-Path -LiteralPath (Join-Path $root $rel) -PathType Leaf) { return $true }
    }
  }
  foreach ($cmd in @('chrome', 'chrome.exe', 'msedge', 'msedge.exe', 'chromium', 'brave', 'brave.exe')) {
    if (Test-HasCommand $cmd) { return $true }
  }
  return $false
}

function Get-BrowserUseDriverCmd {
  param([Parameter(Mandatory = $true)][string]$Root)
  $claude = Get-FullPathNormalized (Join-Path $script:KitHome '.claude\skills')
  $agents = Get-FullPathNormalized (Join-Path $script:KitHome '.agents\skills')
  $rootN = Get-FullPathNormalized $Root
  if (Test-PathsEqual $rootN $claude) {
    return 'browser-use skill install --target claude --no-install'
  }
  if (Test-PathsEqual $rootN $agents) {
    return 'browser-use skill install --target agents --no-install'
  }
  $dest = Join-Path $rootN 'browser-use'
  return "browser-use skill install --path `"$dest`" --no-install"
}

function New-PlanRowDriver {
  param([Parameter(Mandatory = $true)][string]$Root)
  $dest = Join-Path $Root 'browser-use'
  if ((Test-Path -LiteralPath $dest) -or (Test-ReparsePoint $dest)) {
    return (New-PlanRow 'N' 'up to date' $dest)
  }
  if (Test-HasCommand 'browser-use') {
    return (New-PlanRow 'I' 'install driver' $dest)
  }
  return (New-PlanRow 'N' 'missing driver' $dest)
}

function Get-PlanRowsBrowser {
  $rows = New-Object System.Collections.Generic.List[object]
  $names = $script:BrowserSkillNames + $script:BrowserSharedDeps

  $needCli = -not (Test-HasCommand 'browser-use')
  $needBrowser = -not (Test-Chromium)
  if ($needCli -or $needBrowser) {
    $rows.Add((New-PlanRow 'H' 'browser-use - requirements' 'offered after install')) | Out-Null
    if ($needCli) {
      $rows.Add((New-PlanRow 'N' 'missing CLI' 'uv tool install --python 3.12 browser-use')) | Out-Null
    }
    if ($needBrowser) {
      $rows.Add((New-PlanRow 'N' 'missing browser' 'winget install --id Google.Chrome -e')) | Out-Null
    }
  }

  try {
    $override = Resolve-OverrideSkills
  } catch {
    Write-KitDie $_.Exception.Message
  }
  if ($override) {
    $rows.Add((New-PlanRow 'H' 'browser-use (override)' $override)) | Out-Null
    foreach ($name in $names) {
      $source = Get-SkillSource $script:RepoRoot $name
      $dest = Get-SkillDest $override $name
      $rows.Add((New-PlanRowAgent $dest $name $source)) | Out-Null
    }
    $rows.Add((New-PlanRowDriver $override)) | Out-Null
    return $rows
  }

  foreach ($target in $script:AgentTargets) {
    $root = Get-AgentSkillsRoot $target
    $agentLabel = Get-AgentLabel $target
    $parent = Get-AgentParentDir $target
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
      $rows.Add((New-PlanRow 'H' "browser-use - $agentLabel" $root)) | Out-Null
      $rows.Add((New-PlanRow 'N' 'parent missing' $parent)) | Out-Null
      continue
    }
    $rows.Add((New-PlanRow 'H' "browser-use - $agentLabel" $root)) | Out-Null
    foreach ($name in $names) {
      $source = Get-SkillSource $script:RepoRoot $name
      $dest = Get-SkillDest $root $name
      $rows.Add((New-PlanRowAgent $dest $name $source)) | Out-Null
    }
    $rows.Add((New-PlanRowDriver $root)) | Out-Null
  }
  return $rows
}

function Install-DriverInto {
  param([Parameter(Mandatory = $true)][string]$Root)
  $dest = Join-Path $Root 'browser-use'
  if ((Test-Path -LiteralPath $dest) -or (Test-ReparsePoint $dest)) {
    Write-Host "up to date: $dest"
    return
  }
  if (-not (Test-HasCommand 'browser-use')) {
    Write-Host "skipped (no CLI): $dest"
    return
  }
  Write-Host "installing driver: $dest"
  $claude = Get-FullPathNormalized (Join-Path $script:KitHome '.claude\skills')
  $agents = Get-FullPathNormalized (Join-Path $script:KitHome '.agents\skills')
  $rootN = Get-FullPathNormalized $Root
  if (Test-PathsEqual $rootN $claude) {
    & browser-use skill install --target claude --no-install
  } elseif (Test-PathsEqual $rootN $agents) {
    & browser-use skill install --target agents --no-install
  } else {
    & browser-use skill install --path (Join-Path $rootN 'browser-use') --no-install
  }
  if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    throw "browser-use skill install failed for $dest"
  }
}

function Install-BrowserHome {
  $names = $script:BrowserSkillNames + $script:BrowserSharedDeps
  try {
    $override = Resolve-OverrideSkills
  } catch {
    Write-KitDie $_.Exception.Message
  }
  if ($override) {
    Write-Host "== override ($override) =="
    try {
      Install-SkillsInto $override $script:RepoRoot $names
      Install-DriverInto $override
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
      Install-DriverInto $destRoot
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

function Get-BrowserUseMissingDrivers {
  $rows = New-Object System.Collections.Generic.List[object]
  try {
    $override = Resolve-OverrideSkills
  } catch {
    Write-KitDie $_.Exception.Message
  }
  if ($override) {
    $dest = Join-Path $override 'browser-use'
    if (-not (Test-Path -LiteralPath $dest) -and -not (Test-ReparsePoint $dest)) {
      $rows.Add((New-PlanRow 'N' (Get-PathDisplay $dest) (Get-BrowserUseDriverCmd $override))) | Out-Null
    }
    return $rows
  }
  foreach ($target in $script:AgentTargets) {
    $root = Get-AgentSkillsRoot $target
    $parent = Get-AgentParentDir $target
    if (-not (Test-Path -LiteralPath $parent -PathType Container) -and -not (Test-Path -LiteralPath $root -PathType Container)) {
      continue
    }
    $dest = Join-Path $root 'browser-use'
    if (-not (Test-Path -LiteralPath $dest) -and -not (Test-ReparsePoint $dest)) {
      $rows.Add((New-PlanRow 'N' (Get-PathDisplay $dest) (Get-BrowserUseDriverCmd $root))) | Out-Null
    }
  }
  return $rows
}

function Invoke-BrowserUseOffer {
  param([string]$Label, [string]$Cmd)
  Write-Host "  missing: $Label"
  Write-Host "    fix: $Cmd"
  if (-not (Test-IsConsoleInput)) { return }
  Write-Host -NoNewline '    run it now? [y/N] '
  $reply = [Console]::In.ReadLine()
  if ($null -eq $reply) { $reply = '' }
  switch -Regex ($reply.Trim()) {
    '^y$|^Y$|^yes$|^YES$' {
      try {
        Invoke-Expression $Cmd
        if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
          [Console]::Error.WriteLine("    failed, run it yourself: $Cmd")
        }
      } catch {
        [Console]::Error.WriteLine("    failed, run it yourself: $Cmd")
      }
    }
  }
}

function Invoke-BrowserUsePreflight {
  $needCli = -not (Test-HasCommand 'browser-use')
  $needBrowser = -not (Test-Chromium)
  $drivers = @(Get-BrowserUseMissingDrivers)
  if (-not $needCli -and -not $needBrowser -and $drivers.Count -eq 0) { return }

  Write-Host ''
  Write-Host 'browser-use - requirements not met'
  if ($needCli) {
    if (Test-HasCommand 'uv') {
      Invoke-BrowserUseOffer 'browser-use CLI' 'uv tool install --python 3.12 browser-use'
    } else {
      Write-Host '  missing: browser-use CLI'
      Write-Host '    fix: install uv (https://docs.astral.sh/uv/), then:'
      Write-Host '         uv tool install --python 3.12 browser-use'
    }
  }
  if ($needBrowser) {
    if (Test-HasCommand 'winget') {
      Invoke-BrowserUseOffer 'a Chromium-family browser' 'winget install --id Google.Chrome -e'
    } else {
      Write-Host '  missing: a Chromium-family browser'
      Write-Host '    fix: install Google Chrome (https://www.google.com/chrome/)'
    }
  }
  foreach ($driver in $drivers) {
    if (-not $driver.Label) { continue }
    if (Test-HasCommand 'browser-use') {
      Invoke-BrowserUseOffer "browser-use driver skill ($($driver.Label))" $driver.Path
    } else {
      Write-Host "  missing: browser-use driver skill ($($driver.Label))"
      Write-Host "    fix: $($driver.Path)"
    }
  }
  Write-Host "  then, once in the browser: open chrome://inspect/#remote-debugging and"
  Write-Host "  tick 'Allow remote debugging', and sign in to the sites you scout."
  Write-Host ''
}

function Invoke-BrowserUsePlan {
  if (-not (Test-Path -LiteralPath (Join-Path $script:RepoRoot 'skill') -PathType Container)) {
    Write-KitDie "not a job-kit checkout (missing skill/): $($script:RepoRoot)"
  }

  $rows = @(Get-PlanRowsBrowser)
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
    Invoke-BrowserUsePreflight
    return
  }

  if (-not (Confirm-Plan $installs)) { exit 1 }
  Write-Host ''
  Write-Host 'applying'
  Install-BrowserHome
  Invoke-BrowserUsePreflight
  Write-Host ''
  Write-Host "done - $installs installs - 0 failed"
}

function Invoke-BrowserUseMain {
  param([string[]]$Argv = @())
  if ($null -eq $Argv) { $Argv = @() }

  if ($env:HOME -match "`r|`n") { Write-KitDie 'HOME must not contain a line break' }
  if ($env:CLAUDE_SKILLS -match "`r|`n") { Write-KitDie 'CLAUDE_SKILLS must not contain a line break' }

  $i = 0
  while ($i -lt $Argv.Count) {
    $a = $Argv[$i]
    switch -Regex ($a) {
      '^-h$|^--help$' { Show-BrowserUseUsage; exit 0 }
      '^--dry-run$' { $script:DryRun = 1 }
      default { Write-KitDie "unknown option: $a (see --help)" }
    }
    $i++
  }

  Invoke-BrowserUsePlan
}

Invoke-BrowserUseMain @($args)
