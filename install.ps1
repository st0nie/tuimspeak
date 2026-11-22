# tuimspeak installer for Windows (docs/tuimspeak-architecture.md §12.3).
#
#   irm https://raw.githubusercontent.com/st0nie/tuimspeak/main/install.ps1 | iex
#
# Installs the latest release (or $env:TUIMSPEAK_VERSION) into
# %LOCALAPPDATA%\tuimspeak\versions\<version>\, writes the launcher
# %LOCALAPPDATA%\tuimspeak\bin\tuimspeak.cmd and adds that folder to the user
# PATH. Running it again updates; tuimspeak also updates itself (section 12.4).
# $env:TUIMSPEAK_REPO selects another repository.

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  # Windows PowerShell 5.1 may still default to TLS 1.0.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $Repo = if ($env:TUIMSPEAK_REPO) { $env:TUIMSPEAK_REPO } else { 'st0nie/tuimspeak' }
  $Version = $env:TUIMSPEAK_VERSION

  if (-not [Environment]::Is64BitOperatingSystem) { throw 'tuimspeak needs 64-bit Windows.' }
  # Windows on ARM runs the x64 build through emulation.
  $Platform = 'windows-x64'
  $Asset = "tuimspeak-$Platform.zip"
  $Headers = @{ 'User-Agent' = 'tuimspeak-installer'; 'Accept' = 'application/vnd.github+json' }

  if (-not $Version) {
    $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $Headers
    $Version = $Release.tag_name
    if (-not $Version) { throw "Could not find the latest release of $Repo." }
  }
  $Version = $Version.TrimStart('v')

  $Root = Join-Path $env:LOCALAPPDATA 'tuimspeak'
  $Versions = Join-Path $Root 'versions'
  $Target = Join-Path $Versions $Version
  $Bin = Join-Path $Root 'bin'
  $Launcher = Join-Path $Bin 'tuimspeak.cmd'
  $Exe = Join-Path $Target 'tuimspeak.exe'

  if ((Test-Path $Exe) -and (Test-Path $Launcher) -and ((Get-Content $Launcher -Raw) -like "*$Exe*")) {
    Write-Host "tuimspeak $Version is already installed and current."
    return
  }

  $Url = "https://github.com/$Repo/releases/download/v$Version/$Asset"
  $Tmp = Join-Path ([IO.Path]::GetTempPath()) ("tuimspeak-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $Tmp | Out-Null
  try {
    $Zip = Join-Path $Tmp $Asset
    Write-Host "Downloading tuimspeak $Version for $Platform..."
    Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing -Headers @{ 'User-Agent' = 'tuimspeak-installer' }
    Invoke-WebRequest -Uri "$Url.sha256" -OutFile "$Zip.sha256" -UseBasicParsing -Headers @{ 'User-Agent' = 'tuimspeak-installer' }

    $Expected = ((Get-Content "$Zip.sha256" -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
    $Actual = (Get-FileHash -Path $Zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Expected -ne $Actual) { throw "Checksum mismatch for $Asset." }

    New-Item -ItemType Directory -Force -Path $Versions, $Bin | Out-Null
    # Unpack next to the versions so the final move stays on one volume.
    $Work = Join-Path $Versions (".tmp-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    Expand-Archive -Path $Zip -DestinationPath $Work -Force
    $Unpacked = Join-Path $Work "tuimspeak-$Platform"
    if (-not (Test-Path (Join-Path $Unpacked 'tuimspeak.exe'))) { throw 'The archive does not contain tuimspeak.exe.' }
    if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
    Move-Item -Path $Unpacked -Destination $Target
    Remove-Item -Recurse -Force $Work

    # Switch the launcher: write a new one, then replace the old.
    $NewLauncher = "$Launcher.new"
    Set-Content -Path $NewLauncher -Value "@echo off`r`n`"$Exe`" %*" -Encoding ASCII -NoNewline
    Move-Item -Path $NewLauncher -Destination $Launcher -Force

    # Remove other versions; one still running stays until next time.
    Get-ChildItem -Path $Versions -Directory | Where-Object { $_.FullName -ne $Target } | ForEach-Object {
      try { Remove-Item -Recurse -Force $_.FullName } catch { }
    }
  }
  finally {
    Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
  }

  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($UserPath -split ';') -contains $Bin)) {
    $NewPath = if ($UserPath) { "$UserPath;$Bin" } else { $Bin }
    [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')
    $env:Path = "$env:Path;$Bin"
    Write-Host "Added $Bin to your PATH."
  }

  Write-Host "Installed tuimspeak $Version to $Target"
  Write-Host 'Run it in Windows Terminal (the mouse needs it): tuimspeak'
}
