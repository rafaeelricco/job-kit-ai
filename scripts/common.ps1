# Shared installer machinery for Windows: plan rows, rendering, confirm gates.
# Source only — do not execute. Windows PowerShell 5.1 and PowerShell 7.
# Sourced after scripts\agents\lib.ps1 (which provides $script:KitHome and the
# junction mechanics these helpers probe).

# Write-KitDie MESSAGE...
function Write-KitDie {
  param([Parameter(ValueFromRemainingArguments = $true)][object[]]$Message)
  $text = ($Message | ForEach-Object { "$_" }) -join ' '
  [Console]::Error.WriteLine("error: $text")
  exit 1
}

# Test-IsConsoleInput — false when stdin is redirected (pipe-safe gates).
function Test-IsConsoleInput {
  try {
    return -not [Console]::IsInputRedirected
  } catch {
    return $true
  }
}

# Get-PathDisplay PATH — ~-relative rendering for plan output.
function Get-PathDisplay {
  param([Parameter(Mandatory = $true)][string]$Path)
  $userHome = $script:KitHome
  if (Test-PathsEqual $Path $userHome) { return '~' }
  $prefix = (Get-FullPathNormalized $userHome) + '\'
  $full = $Path
  try { $full = Get-FullPathNormalized $Path } catch { $full = $Path }
  if ($full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    return '~/' + (($full.Substring($prefix.Length)) -replace '\\', '/')
  }
  return $Path
}

# Get-SkillLeaf ROOT PATH — the single segment under ROOT, or '' when deeper.
function Get-SkillLeaf {
  param([string]$Root, [string]$Path)
  if (-not $Root -or -not $Path) { return '' }
  $rootN = $Root
  $pathN = $Path
  try { $rootN = Get-FullPathNormalized $Root } catch { }
  try { $pathN = Get-FullPathNormalized $Path } catch { }
  $prefix = $rootN.TrimEnd('\') + '\'
  if (-not $pathN.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return '' }
  $rest = $pathN.Substring($prefix.Length)
  if (-not $rest -or $rest.Contains('\') -or $rest.Contains('/')) { return '' }
  return $rest
}

# New-PlanRow KIND LABEL PATH
# Kinds: H header, I install/remove, N no-op, X irreversible.
function New-PlanRow {
  param([string]$Kind, [string]$Label, [string]$Path)
  return [pscustomobject]@{ Kind = $Kind; Label = $Label; Path = $Path }
}

# New-PlanRowAgent DEST NAME SOURCE
# One skill row for a coding-agent home. A stale kit link relinks; any other
# existing path is foreign and goes through Resolve-PlanBlockers.
function New-PlanRowAgent {
  param([string]$Dest, [string]$Name, [string]$Source)
  if (-not (Test-Path -LiteralPath $Source -PathType Container) -or -not (Test-Path -LiteralPath (Join-Path $Source 'SKILL.md') -PathType Leaf)) {
    return (New-PlanRow 'N' 'source missing' $Dest)
  }
  if (Test-ExactLink $Dest $Source) {
    return (New-PlanRow 'N' 'up to date' $Dest)
  }
  if (Test-StaleKitPath $Dest $Name) {
    return (New-PlanRow 'I' 'relink' $Dest)
  }
  if ((Test-Path -LiteralPath $Dest) -or (Test-ReparsePoint $Dest)) {
    return (New-PlanRow 'N' 'foreign' $Dest)
  }
  return (New-PlanRow 'I' 'link' $Dest)
}

function Add-PlanRowsLegacyAgentSkills {
  param([object]$Rows, [string]$Root)
  foreach ($name in $script:LegacySkillNames) {
    $dest = Get-SkillDest $Root $name
    if (Test-KitSkillLink $dest $script:RepoRoot $name) {
      $Rows.Add((New-PlanRow 'I' 'remove legacy link' $dest)) | Out-Null
    }
  }
}

# Get-PlanCount ROWS KINDS
function Get-PlanCount {
  param([object[]]$Rows, [string[]]$Kinds)
  $n = 0
  foreach ($row in $Rows) {
    if ($Kinds -contains $row.Kind) { $n++ }
  }
  return $n
}

# Test-StaleKitPath DEST NAME
# True when DEST is a kit install whose checkout is gone: a junction/symlink,
# or a copy's .job-kit marker, naming *\skill\NAME at a path that no longer exists.
function Test-StaleKitPath {
  param([string]$Dest, [string]$Name)
  $target = $null
  if (Test-ReparsePoint $Dest) {
    $target = Get-LinkTarget $Dest
  } elseif (Test-Path -LiteralPath (Join-Path $Dest '.job-kit') -PathType Leaf) {
    try { $target = [IO.File]::ReadAllText((Join-Path $Dest '.job-kit')).TrimEnd([char]13, [char]10) } catch { return $false }
  }
  if (-not $target) { return $false }
  if ($target -notmatch ('[\\/]skill[\\/]' + [regex]::Escape($Name) + '$')) { return $false }
  return (-not (Test-Path -LiteralPath $target))
}

# Resolve-PlanBlockers ROWS — die on missing sources; for foreign rows print the
# removal commands, and on a console offer to replace them (sets $script:Force).
# Returns how many extra installs the replacement adds.
function Resolve-PlanBlockers {
  param([object[]]$Rows)
  if (@($Rows | Where-Object { $_.Kind -eq 'N' -and $_.Label -eq 'source missing' }).Count -gt 0) {
    Write-KitDie 'plan has missing skill sources; this checkout is incomplete (see plan)'
  }
  $foreign = @($Rows | Where-Object { $_.Kind -eq 'N' -and $_.Label -eq 'foreign' })
  if ($foreign.Count -eq 0) { return 0 }
  Write-Host "$($foreign.Count) foreign paths block the install (not made by job-kit). To clear them:"
  foreach ($row in $foreign) {
    $quoted = "'" + ($row.Path -replace "'", "''") + "'"
    if (Test-ReparsePoint $row.Path) {
      Write-Host "  [IO.Directory]::Delete($quoted)"
    } else {
      Write-Host "  Remove-Item -LiteralPath $quoted -Recurse -Force"
    }
  }
  Write-Host ''
  if ($script:DryRun -eq 1 -or -not (Test-IsConsoleInput) -or
      -not (Confirm-TypedYes 'Replace them with kit copies now? Type yes to confirm: ')) {
    Write-KitDie 'foreign paths at the destination; remove them (commands above) and re-run'
  }
  $script:Force = 1
  return $foreign.Count
}

# Write-Plan ROWS [-Irreversible]
# Renders the plan. -Irreversible switches to the uninstall shape: the
# uninstall title, the "remove link (tag)" collapse, and the X marker.
function Write-Plan {
  param([object[]]$Rows, [switch]$Irreversible)
  $sectionRoot = ''
  $sectionStarted = $false

  # nested functions cannot assign outer locals in PS 5.1 the way bash can;
  # keep pending state on script scope for the renderer only.
  $script:pendLabel = ''
  $script:pendNames = ''

  if ($Irreversible) {
    Write-Host 'job-kit uninstall - plan'
  } else {
    Write-Host 'job-kit install - plan'
  }
  Write-Host ''
  foreach ($row in $Rows) {
    if (-not $row.Kind) { continue }
    if ($row.Kind -eq 'H') {
      if ($script:pendLabel) {
        Write-Host ("  {0,-16} {1}" -f $script:pendLabel, $script:pendNames)
        $script:pendLabel = ''
        $script:pendNames = ''
      }
      if ($sectionStarted) { Write-Host '' }
      $sectionStarted = $true
      $sectionRoot = $row.Path
      Write-Host ("{0}  -  {1}" -f $row.Label, (Get-PathDisplay $row.Path))
      continue
    }

    $leaf = ''
    if ($sectionRoot) { $leaf = Get-SkillLeaf $sectionRoot $row.Path }

    if ($row.Kind -eq 'N' -and $leaf) {
      if ($script:pendLabel -eq $row.Label) {
        $script:pendNames = $script:pendNames + ', ' + $leaf
        continue
      }
      if ($script:pendLabel) {
        Write-Host ("  {0,-16} {1}" -f $script:pendLabel, $script:pendNames)
      }
      $script:pendLabel = $row.Label
      $script:pendNames = $leaf
      continue
    }

    if ($script:pendLabel) {
      Write-Host ("  {0,-16} {1}" -f $script:pendLabel, $script:pendNames)
      $script:pendLabel = ''
      $script:pendNames = ''
    }

    if ($row.Kind -eq 'I' -and $leaf) {
      if ($Irreversible) {
        if ($row.Label -like 'remove link (*') {
          $rest = $row.Label.Substring('remove '.Length)
          $action = 'remove ' + ($rest -replace ' \(.*$', '')
          $tag = ([regex]::Match($row.Label, '\(([^)]+)\)$')).Groups[1].Value
          Write-Host ("  {0,-16} {1} ({2})" -f $action, $leaf, $tag)
          continue
        }
      } elseif (@('link', 'relink', 'install driver', 'remove legacy link') -contains $row.Label) {
        Write-Host ("  {0,-16} {1}" -f $row.Label, $leaf)
        continue
      }
    }

    if ($Irreversible -and $row.Kind -eq 'X') {
      Write-Host ("  {0,-16} {1}  - irreversible" -f $row.Label, (Get-PathDisplay $row.Path))
    } else {
      Write-Host ("  {0,-16} {1}" -f $row.Label, (Get-PathDisplay $row.Path))
    }
  }
  if ($script:pendLabel) {
    Write-Host ("  {0,-16} {1}" -f $script:pendLabel, $script:pendNames)
    $script:pendLabel = ''
    $script:pendNames = ''
  }
  Write-Host '--------------------------------------------------------------'
}

# Confirm-Plan INSTALLS
# Console gets [Y/n]; redirected stdin applies after the plan.
function Confirm-Plan {
  param([int]$Installs)
  if (-not (Test-IsConsoleInput)) { return $true }
  Write-Host -NoNewline "Proceed? $Installs installs. [Y/n] "
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

# Confirm-TypedYes PROMPT
# Irreversible gate: the literal word yes, never a bare Enter.
function Confirm-TypedYes {
  param([string]$Prompt)
  Write-Host -NoNewline $Prompt
  $answer = [Console]::In.ReadLine()
  if ($null -eq $answer) { $answer = '' }
  if ($answer.Trim() -eq 'yes') { return $true }
  [Console]::Error.WriteLine('aborted (type yes to confirm).')
  return $false
}

# Test-AgentsReady — true when some coding-agent home exists (or CLAUDE_SKILLS).
function Test-AgentsReady {
  if ($env:CLAUDE_SKILLS) { return $true }
  $userHome = Get-KitUserHome
  foreach ($rel in @('.claude', '.agents', '.grok', '.hermes')) {
    if (Test-Path -LiteralPath (Join-Path $userHome $rel) -PathType Container) { return $true }
  }
  return $false
}

# Test-AsideReady — true when Aside's skills parent exists (or ASIDE_SKILLS).
function Test-AsideReady {
  if ($env:ASIDE_SKILLS) { return $true }
  $account = '0'
  if ($env:ASIDE_ACCOUNT) { $account = $env:ASIDE_ACCOUNT }
  $parent = Join-Path (Get-KitUserHome) ".aside\u\$account\skills"
  return (Test-Path -LiteralPath $parent -PathType Container)
}
