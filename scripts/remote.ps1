# Fetch a released job-kit bundle, then run the Windows channel installers.
# Windows PowerShell 5.1 and PowerShell 7. Safe to download, then:
#   powershell -ExecutionPolicy Bypass -File remote.ps1 all
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:JobKitSlug = 'rafaeelricco/job-kit'
if ($env:JOB_KIT_SLUG) { $script:JobKitSlug = $env:JOB_KIT_SLUG }
$script:JobKitVersion = 'latest'
if ($env:JOB_KIT_VERSION) { $script:JobKitVersion = $env:JOB_KIT_VERSION }

function Write-KitDie {
  param([Parameter(ValueFromRemainingArguments = $true)][object[]]$Message)
  $text = ($Message | ForEach-Object { "$_" }) -join ' '
  [Console]::Error.WriteLine("error: $text")
  exit 1
}

function Get-FullPathNormalized {
  param([Parameter(Mandatory = $true)][string]$Path)
  $full = [IO.Path]::GetFullPath($Path)
  if ($full.Length -gt 3) { $full = $full.TrimEnd('\') }
  return $full
}

function Test-RootedPath {
  param([string]$Path)
  if (-not $Path) { return $false }
  return [IO.Path]::IsPathRooted($Path)
}

function Get-KitUserHome {
  $h = $null
  if ($env:HOME -and (Test-RootedPath $env:HOME)) {
    $h = $env:HOME
  } else {
    $h = $env:USERPROFILE
  }
  if (-not $h -or -not (Test-RootedPath $h)) {
    Write-KitDie "HOME must be an absolute path (got: $h)"
  }
  if ($h -match "`r|`n") { Write-KitDie 'HOME must not contain a line break' }
  return (Get-FullPathNormalized $h)
}

function Get-JobKitHomePath {
  if ($env:JOB_KIT_HOME) {
    if ($env:JOB_KIT_HOME -match "`r|`n") { Write-KitDie 'JOB_KIT_HOME must not contain a line break' }
    if (-not (Test-RootedPath $env:JOB_KIT_HOME)) {
      Write-KitDie "JOB_KIT_HOME must be an absolute path (got: $($env:JOB_KIT_HOME))"
    }
    return (Get-FullPathNormalized $env:JOB_KIT_HOME)
  }
  if ($env:XDG_DATA_HOME) {
    if ($env:XDG_DATA_HOME -match "`r|`n") { Write-KitDie 'XDG_DATA_HOME must not contain a line break' }
    if (-not (Test-RootedPath $env:XDG_DATA_HOME)) {
      Write-KitDie "XDG_DATA_HOME must be an absolute path (got: $($env:XDG_DATA_HOME))"
    }
    return (Join-Path (Get-FullPathNormalized $env:XDG_DATA_HOME) 'job-kit')
  }
  return (Join-Path (Get-KitUserHome) '.local\share\job-kit')
}

$script:JobKitHome = Get-JobKitHomePath

$script:KitOwnershipFiles = @(
  'scripts\agents\install.sh',
  'scripts\agents\lib.sh',
  'scripts\aside\install.sh',
  'scripts\aside\lib.sh',
  'scripts\install.sh',
  'scripts\uninstall.sh',
  'skill\job-profile\SKILL.md',
  'skill\job-scout\SKILL.md'
)

$script:KitPreviousOwnershipFiles = @(
  'scripts\agents\install.sh',
  'scripts\agents\lib.sh',
  'scripts\aside\install.sh',
  'scripts\aside\lib.sh',
  'scripts\install.sh',
  'scripts\uninstall.sh',
  'skill\job-profile-init\SKILL.md',
  'skill\job-scout\SKILL.md'
)

$script:KitRequiredFiles = $script:KitOwnershipFiles + @(
  'scripts\common.sh',
  'scripts\browser-use\install.sh',
  'skill\captcha-solver\SKILL.md',
  'skill\job-apply\SKILL.md',
  'skill\job-prep\SKILL.md',
  'skill\job-resume-refine\SKILL.md',
  'skill\job-list\SKILL.md',
  'skill\job-match\SKILL.md',
  'skill\job-match\scripts\score.py',
  'skill\job-match\scripts\models.py',
  'skill\job-match\scripts\scaffold_guidance.py',
  'skill\job-match\scripts\validate_guidance.py',
  'skill\job-match\scripts\typesafe_match.py',
  'skill\job-match\scripts\years.py',
  'skill\job-profile\scripts\geography.py',
  'skill\job-profile\scripts\geography.json',
  'skill\job-profile\references\contracts\contract-geography.md',
  'skill\job-resume-refine\scripts\check_parse.py',
  'skill\job-resume-refine\scripts\evaluate_pdf.py',
  'skill\job-store\scripts\normalize_url.py',
  'skill\job-store\scripts\validate_extract.py',
  'skill\job-store\scripts\validate_dossier.py',
  'skill\job-store\scripts\normalize_source.py',
  'skill\job-humanize\scripts\detect.py',
  'skill\job-stories\SKILL.md',
  'skill\job-inbox\SKILL.md',
  'skill\job-humanize\SKILL.md',
  'skill\job-profile-root\SKILL.md',
  'skill\job-store\SKILL.md',
  'scripts\remote.sh',
  'scripts\remote.ps1',
  'LICENSE'
)

$script:WindowsRequiredFiles = @(
  'scripts\install.ps1',
  'scripts\uninstall.ps1',
  'scripts\agents\lib.ps1',
  'scripts\agents\install.ps1',
  'scripts\common.ps1',
  'scripts\browser-use\install.ps1',
  'scripts\aside\lib.ps1',
  'scripts\aside\install.ps1'
)

function Show-RemoteUsage {
  @'
Install or uninstall released job-kit skills (Windows 11; no Git required).

Usage: remote.ps1 [channel] [options...]
       remote.ps1 uninstall [target] [options...]

Install channels:
  all          Aside + coding agents + browser-use, skipping absent (default)
  agents       Coding agents only (fails when no agent home exists)
  aside        Aside skills (fails when Aside is not set up)
  browser-use  job-scout + job-apply + job-prep plus the browser-use driver
               skill into coding-agent homes (needs an agent home)
  fetch        Refresh the installed release bundle, install no skills

Uninstall:
  uninstall              Aside + agent + browser-use skills (default: all)
  uninstall all          Same
  uninstall aside        Aside only
  uninstall agents       Coding agents only
  uninstall browser-use  job-scout + job-apply + job-prep links, the
                         browser-use driver skill, the CLI, and its state
                         (never your browser)

  Interactive (profile data + menu): powershell -File scripts\uninstall.ps1
  from a local checkout or installed package. Remote uninstall never deletes
  %USERPROFILE%\.config\job-kit.

  -h, --help  Show this help

Install options after the channel are forwarded to the installer. The only
one is --dry-run.

Uninstall options:
  --purge             After full uninstall only, remove the installed package
                      (refused on a partial target such as `uninstall agents`,
                      while CLAUDE_SKILLS narrows a channel, and with stdin
                      redirected, which cannot type the required `yes` —
                      run it from a console against the installed package)

Environment:
  JOB_KIT_HOME     Installed package (default $XDG_DATA_HOME\job-kit or ~\.local\share\job-kit)
  JOB_KIT_VERSION  Released vX.Y.Z tag, or latest (default latest)
  JOB_KIT_SLUG     GitHub owner/repo (default rafaeelricco/job-kit)

JOB_KIT_REF is no longer supported for fetching. Use JOB_KIT_VERSION for a
released tag, or run a local checkout for branch development.
The installed version is recorded in JOB_KIT_HOME\VERSION. Legacy checkouts
are preserved in a sibling backup when first replaced by a release bundle.
'@ | Write-Host
}

function Test-ReparsePoint {
  param([Parameter(Mandatory = $true)][string]$Path)
  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  } catch {
    return $false
  }
  return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

function Get-KitPathsMissing {
  param([string]$Dir, [string[]]$Files)
  $skill = Join-Path $Dir 'skill'
  if ((Test-ReparsePoint $skill) -or -not (Test-Path -LiteralPath $skill -PathType Container)) {
    return 'skill/'
  }
  foreach ($rel in $Files) {
    $cur = $Dir
    foreach ($part in ($rel -split '\\')) {
      if (-not $part) { continue }
      $cur = Join-Path $cur $part
      if (Test-ReparsePoint $cur) { return ($rel -replace '\\', '/') }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Dir $rel) -PathType Leaf)) {
      return ($rel -replace '\\', '/')
    }
  }
  return ''
}

function Get-KitOwnedMissing {
  param([string]$Dir)
  return (Get-KitPathsMissing $Dir $script:KitOwnershipFiles)
}

function Get-KitCheckoutMissing {
  param([string]$Dir)
  $missing = Get-KitPathsMissing $Dir $script:KitRequiredFiles
  if ($missing) { return $missing }
  return (Get-KitPathsMissing $Dir $script:WindowsRequiredFiles)
}

function Get-InstalledKitVersion {
  param([string]$Dir)
  $file = Join-Path $Dir 'VERSION'
  if ((Test-ReparsePoint $file) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { return '' }
  $version = [IO.File]::ReadAllText($file)
  if ($version -cmatch '\Av[0-9]+\.[0-9]+\.[0-9]+\n\z') { return $version.TrimEnd([char]"`n") }
  return ''
}

function Resolve-KitCachePath {
  param([string]$Path)
  $current = Get-FullPathNormalized $Path
  for ($i = 0; $i -lt 32; $i++) {
    if (-not (Test-ReparsePoint $current)) { return $current }
    $item = Get-Item -LiteralPath $current -Force
    $targets = @($item.Target)
    if ($targets.Count -eq 0 -or -not $targets[0]) {
      throw "cannot resolve cache alias: $current"
    }
    $target = [string]$targets[0]
    if ($target.StartsWith('\??\')) { $target = $target.Substring(4) }
    if (-not [IO.Path]::IsPathRooted($target)) {
      $target = Join-Path (Split-Path $current -Parent) $target
    }
    $current = Get-FullPathNormalized $target
  }
  throw "cache alias chain is too deep: $Path"
}

function Expand-KitRelease {
  param([string]$Archive, [string]$Dest)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName
      if (-not $name.StartsWith('job-kit/', [StringComparison]::Ordinal) -or $name.Contains('\')) {
        throw "unsafe release archive path: $name"
      }
      $parts = $name.TrimEnd('/').Split('/')
      foreach ($part in $parts) {
        if (-not $part -or $part -eq '.' -or $part -eq '..' -or
            $part -match '[\x00-\x1f<>:"|?*]' -or $part -match '[. ]$' -or
            $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
          throw "unsafe release archive path: $name"
        }
      }
      if ($parts.Count -gt 1 -and $parts[1] -eq '.git') {
        throw 'release archive must not contain .git'
      }
      $mode = ($entry.ExternalAttributes -shr 16) -band 0xF000
      if (($mode -ne 0 -and $mode -ne 0x8000 -and $mode -ne 0x4000) -or
          ($entry.ExternalAttributes -band [int][IO.FileAttributes]::ReparsePoint)) {
        throw "release archive contains a link or special file: $name"
      }
      if (-not $seen.Add($name.TrimEnd('/'))) {
        throw "duplicate release archive path: $name"
      }
    }
  } finally {
    $zip.Dispose()
  }
  # All member paths and types are checked before any member is extracted.
  [IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Dest)
}

function Invoke-FetchKit {
  param([string]$Dest)
  if ($env:JOB_KIT_REF) {
    Write-KitDie 'JOB_KIT_REF is no longer supported; unset it and use JOB_KIT_VERSION=vX.Y.Z, or run a local checkout for branch development'
  }
  if ($script:JobKitVersion -cne 'latest' -and $script:JobKitVersion -cnotmatch '\Av[0-9]+\.[0-9]+\.[0-9]+\z') {
    Write-KitDie "JOB_KIT_VERSION must be latest or a released vX.Y.Z tag (got: $($script:JobKitVersion))"
  }

  $stage = ''
  $failure = ''
  try {
    $physical = Resolve-KitCachePath $Dest
    $exists = (Test-Path -LiteralPath $Dest) -or (Test-ReparsePoint $Dest)
    $legacy = $false
    if ($exists) {
      $missing = Get-KitOwnedMissing $physical
      if ($missing) { throw "cache path exists and is not a job-kit package (missing $missing): $Dest" }
      $gitEntry = Join-Path $physical '.git'
      if ((Test-ReparsePoint $gitEntry) -or
          ((Test-Path -LiteralPath $gitEntry) -and -not (Test-Path -LiteralPath $gitEntry -PathType Container))) {
        throw "refusing to migrate a cache with a .git file or link: $Dest; use a separate JOB_KIT_HOME"
      }
      $legacy = (Test-Path -LiteralPath $gitEntry) -or -not (Get-InstalledKitVersion $physical) -or
        [bool](Get-KitCheckoutMissing $physical)
    }

    $parent = Split-Path $physical -Parent
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
      New-Item -ItemType Directory -Path $parent | Out-Null
    }
    $token = [Guid]::NewGuid().ToString('N')
    $stage = Join-Path $parent ('.job-kit-fetch.' + $token)
    $backup = $physical + '.backup-' + $token
    New-Item -ItemType Directory -Path $stage | Out-Null

    $version = $script:JobKitVersion
    $releaseRoot = "https://github.com/$($script:JobKitSlug)/releases"
    if ($version -ceq 'latest') {
      $versionFile = Join-Path $stage 'VERSION'
      Invoke-WebRequest -Uri "$releaseRoot/latest/download/VERSION" -OutFile $versionFile -UseBasicParsing
      $version = Get-InstalledKitVersion $stage
      if (-not $version) {
        throw 'latest release VERSION must contain a released vX.Y.Z tag'
      }
    }
    $asset = "job-kit-$version.zip"
    $releaseUrl = "$releaseRoot/download/$version"
    $archive = Join-Path $stage $asset
    $checksums = Join-Path $stage 'SHA256SUMS'
    Invoke-WebRequest -Uri "$releaseUrl/$asset" -OutFile $archive -UseBasicParsing
    Invoke-WebRequest -Uri "$releaseUrl/SHA256SUMS" -OutFile $checksums -UseBasicParsing
    $pattern = '\A([0-9a-fA-F]{64}) [ *]' + [regex]::Escape($asset) + '\z'
    $expected = @(
      foreach ($line in [IO.File]::ReadAllLines($checksums)) {
        if ($line -cmatch $pattern) { $Matches[1] }
      }
    )
    if ($expected.Count -ne 1) { throw "SHA256SUMS must contain exactly one checksum for $asset" }
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    if ($actual -ne $expected[0]) { throw "checksum mismatch for $asset" }

    $unpacked = Join-Path $stage 'unpacked'
    Expand-KitRelease $archive $unpacked
    $package = Join-Path $unpacked 'job-kit'
    $missing = Get-KitCheckoutMissing $package
    if ($missing) { throw "release $version is missing $missing; cache left unchanged" }
    if ((Get-InstalledKitVersion $package) -cne $version) {
      throw "release bundle VERSION does not match $version; cache left unchanged"
    }

    # Replace the physical directory, preserving any alias and existing junction targets.
    if ($exists) { Move-Item -LiteralPath $physical -Destination $backup }
    try {
      Move-Item -LiteralPath $package -Destination $physical
    } catch {
      $moveError = $_.Exception.Message
      if ($exists) {
        try {
          if ((Test-Path -LiteralPath $physical) -or (Test-ReparsePoint $physical)) {
            throw "replacement destination already exists: $physical"
          }
          Move-Item -LiteralPath $backup -Destination $physical
        } catch {
          throw "release replacement failed ($moveError); rollback failed; previous package kept at $backup"
        }
        throw "release replacement failed ($moveError); previous cache restored"
      }
      throw "release replacement failed ($moveError)"
    }
    if ($exists) {
      if ($legacy) {
        Write-Host "legacy checkout preserved at: $backup"
      } else {
        try { Remove-Item -LiteralPath $backup -Recurse -Force } catch {
          Write-Warning "release installed, but previous bundle could not be removed: $backup"
        }
      }
    }
    Write-Host "fetched: $Dest @ $version"
  } catch {
    $failure = $_.Exception.Message
  } finally {
    if ($stage -and (Test-Path -LiteralPath $stage)) {
      Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  if ($failure) { Write-KitDie "release install failed: $failure" }
}

function Assert-Checkout {
  param([string]$Dir)
  $missing = Get-KitCheckoutMissing $Dir
  if ($missing) {
    Write-KitDie "not a job-kit package (missing $missing): $Dir"
  }
}

function Invoke-EnsureKitCache {
  param([string]$Dest)
  if (-not (Test-Path -LiteralPath $Dest) -and -not (Test-ReparsePoint $Dest)) {
    Invoke-FetchKit $Dest
    Assert-Checkout $Dest
    return
  }
  $missing = Get-KitOwnedMissing $Dest
  if ($missing) {
    $previous = Get-KitPathsMissing $Dest $script:KitPreviousOwnershipFiles
    if (-not $previous) {
      Write-Host "refreshing kit cache (skill names changed): $Dest"
      Invoke-FetchKit $Dest
      Assert-Checkout $Dest
      return
    }
    Write-KitDie "cache path exists and is not a job-kit package (missing $missing): $Dest"
  }
  # Caches fetched by the Git Bash installer before this channel pass the
  # ownership probe but carry none of the Windows scripts, so the cached
  # uninstaller would be missing. Refresh once instead of dying before
  # anything is removed.
  $missing = Get-KitPathsMissing $Dest $script:WindowsRequiredFiles
  if ($missing) {
    Write-Host "refreshing kit cache (windows scripts added, missing $missing): $Dest"
    Invoke-FetchKit $Dest
    Assert-Checkout $Dest
  }
}

function Invoke-CachedScript {
  param([string]$RelPath, [string[]]$Forward)
  $file = Join-Path $script:JobKitHome $RelPath
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    Write-KitDie "cached installer missing: $file"
  }
  # Downloads no longer invoke native git/tar, so there may be no prior exit code.
  $global:LASTEXITCODE = 0
  & $file @Forward
  if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Invoke-RemoteMain {
  param([string[]]$Argv = @())
  if ($null -eq $Argv) { $Argv = @() }

  $channel = 'all'
  $mode = 'install'
  $target = 'all'
  $purge = $false
  $forward = New-Object System.Collections.Generic.List[string]

  $i = 0
  if ($Argv.Count -gt 0) {
    switch ($Argv[0]) {
      'uninstall' {
        $mode = 'uninstall'
        $i = 1
        if ($i -lt $Argv.Count -and @('all', 'aside', 'agents', 'browser-use') -contains $Argv[$i]) {
          $target = $Argv[$i]
          $i++
        }
      }
      { @('all', 'aside', 'agents', 'browser-use', 'fetch') -contains $_ } {
        $channel = $Argv[0]
        $i = 1
      }
      { $_ -eq '-h' -or $_ -eq '--help' } { Show-RemoteUsage; exit 0 }
      default { $i = 0 }
    }
  }

  if ($mode -eq 'uninstall') {
    while ($i -lt $Argv.Count) {
      $arg = $Argv[$i]
      if ($arg -eq '--purge') {
        $purge = $true
        $i++
        continue
      }
      if ($arg -eq '-h' -or $arg -eq '--help') { Show-RemoteUsage; exit 0 }
      Write-KitDie "uninstall $target accepts only --purge (got: $arg)"
    }

    if ($purge) {
      # The cache is an irreversible row, so uninstall.ps1 gates it behind a
      # typed "yes" read from stdin. With stdin redirected, that read returns
      # $null and the whole run aborts after the plan is printed — nothing
      # removed, no hint shown. Refuse up front and name the local command,
      # which prompts on a console.
      $isConsole = $true
      try { $isConsole = -not [Console]::IsInputRedirected } catch { $isConsole = $true }
      if (-not $isConsole) {
        Write-KitDie "refusing --purge with redirected input (removing the cache needs a typed 'yes'; run: powershell -ExecutionPolicy Bypass -File `"$($script:JobKitHome)\scripts\remote.ps1`" uninstall --purge)"
      }
      if ($target -ne 'all') {
        Write-KitDie "refusing --purge with partial uninstall (use 'uninstall all --purge' or omit --purge)"
      }
      if ($env:CLAUDE_SKILLS) {
        Write-KitDie "refusing --purge while CLAUDE_SKILLS narrows the agents uninstall to $($env:CLAUDE_SKILLS) (unset it, or omit --purge)"
      }
    }

    Invoke-EnsureKitCache $script:JobKitHome

    switch ($target) {
      'aside' {
        Invoke-CachedScript 'scripts\uninstall.ps1' @('aside')
      }
      'agents' {
        Invoke-CachedScript 'scripts\uninstall.ps1' @('agents')
      }
      'browser-use' {
        Invoke-CachedScript 'scripts\uninstall.ps1' @('browser-use')
      }
      'all' {
        if ($purge) {
          Invoke-CachedScript 'scripts\uninstall.ps1' @('aside', 'agents', 'browser-use', 'cache')
        } else {
          Invoke-CachedScript 'scripts\uninstall.ps1' @('aside', 'agents', 'browser-use')
        }
      }
    }

    Write-Host ''
    if ($purge) {
      Write-Host 'job-kit uninstall finished (cache purged)'
    } else {
      Write-Host 'job-kit uninstall finished'
      Write-Host "  cache kept at: $($script:JobKitHome)"
      Write-Host "  reinstall: powershell -ExecutionPolicy Bypass -File remote.ps1 all"
      Write-Host "  purge cache: powershell -ExecutionPolicy Bypass -File `"$($script:JobKitHome)\scripts\remote.ps1`" uninstall --purge"
    }
    return
  }

  while ($i -lt $Argv.Count) {
    $forward.Add($Argv[$i]) | Out-Null
    $i++
  }

  Invoke-FetchKit $script:JobKitHome
  Assert-Checkout $script:JobKitHome

  switch ($channel) {
    'fetch' { }
    'aside' {
      Invoke-CachedScript 'scripts\aside\install.ps1' @($forward.ToArray())
    }
    'agents' {
      Invoke-CachedScript 'scripts\agents\install.ps1' @($forward.ToArray())
    }
    'browser-use' {
      Invoke-CachedScript 'scripts\browser-use\install.ps1' @($forward.ToArray())
    }
    'all' {
      # install.ps1 owns what "all" means, including the readiness gates.
      Invoke-CachedScript 'scripts\install.ps1' (@('all') + @($forward.ToArray()))
    }
  }

  Write-Host ''
  Write-Host "job-kit cached at: $($script:JobKitHome)"
  Write-Host '  keep it: agent skills junction into it'
  Write-Host "  uninstall (interactive / profile): powershell -ExecutionPolicy Bypass -File `"$($script:JobKitHome)\scripts\uninstall.ps1`""
  Write-Host '  uninstall (skills only): powershell -ExecutionPolicy Bypass -File remote.ps1 uninstall'
}

Invoke-RemoteMain @($args)
