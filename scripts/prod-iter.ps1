# Build Vimperium, reinstall it over the local prod install and relaunch it (Windows).
# macOS counterpart: scripts/prod-iter.sh.
#
#   scripts\prod-iter.ps1 [commit message]
#
# The order is deliberate. Commit first: the husky pre-commit hook bumps the patch version,
# and that number is the only way to tell the new build from the old one. Build while Vimperium
# keeps running (the build only writes to out\ and release\). Stop it only for the few
# seconds the install takes. Push last, once the new build is running.
#
# Get-Process Vimperium matches only the installed app: an `npm run dev` instance runs as
# electron.exe and is never touched. Newbro is the app's name before the rename. It must not be
# running when the first Vimperium starts, because that launch moves Newbro's data into
# Vimperium's folder.

param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Message
)

$ErrorActionPreference = 'Stop'

function Step($Text) { Write-Host "`n==> $Text" -ForegroundColor Cyan }

# Native commands don't throw on a non-zero exit code, so check it explicitly.
function Invoke-Checked([scriptblock]$Command) {
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "exit code ${LASTEXITCODE}: $Command" }
}

function Get-PkgVersion { (Get-Content package.json -Raw | ConvertFrom-Json).version }

# Main and helper processes of the installed app, under its current and its old name.
$appProcesses = 'Vimperium', 'Newbro'

# Where the installer puts Vimperium.exe. NSIS records the install folder under its GUID, and
# /S reinstalls into that folder. package.json pins build.nsis.guid to Newbro's GUID, so the
# first Vimperium install upgrades Newbro in place and the folder stays
# %LOCALAPPDATA%\Programs\Newbro. A machine that never had either gets Programs\Vimperium.
# The key is under HKCU for a per-user install (the default) and HKLM for one for all users.
function Get-InstalledExe {
  foreach ($hive in 'HKCU:', 'HKLM:') {
    $key = "$hive\Software\47ded20f-0973-5f4e-a153-6fc5ae43dad6"
    if (Test-Path -LiteralPath $key) {
      $dir = (Get-ItemProperty -LiteralPath $key).InstallLocation
      if ($dir) { return Join-Path $dir 'Vimperium.exe' }
    }
  }
  Join-Path $env:LOCALAPPDATA 'Programs\Vimperium\Vimperium.exe'
}

# electron-builder stamps the exe as "1.2.3" or "1.2.3.0" depending on the field.
function Get-ExeVersion($Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return 'none' }
  (Get-Item -LiteralPath $Path).VersionInfo.ProductVersion -replace '^(\d+\.\d+\.\d+)\.0$', '$1'
}

$repo = Split-Path $PSScriptRoot -Parent
Push-Location $repo
try {
  $exe = Get-InstalledExe
  $log = Join-Path $env:APPDATA 'Vimperium\vimperium.log'

  Step '1/7 Commit'
  $oldVersion = Get-PkgVersion
  $status = git status --porcelain
  if ($LASTEXITCODE -ne 0) { throw 'git status failed' }
  if (-not $status) {
    $installed = Get-ExeVersion $exe
    # A clean tree still has something to ship when the last commit (and its version bump)
    # never made it into the install.
    if ($installed -eq $oldVersion) {
      Write-Host "Working tree is clean and $exe is already $oldVersion."
      if ([Console]::IsInputRedirected) { return }
      $answer = Read-Host "Rebuild and reinstall $oldVersion anyway? [y/N]"
      if ($answer -notmatch '^[yY]') { return }
    } else {
      Write-Host "Working tree is clean, shipping $oldVersion over the installed $installed."
    }
    $version = $oldVersion
  } else {
    Invoke-Checked { git add -A }
    if ($Message) {
      Invoke-Checked { git commit -m ($Message -join ' ') }
    } else {
      $files = (git diff --cached --name-status) -join "`n"
      Invoke-Checked { git commit -m 'Prod iter checkpoint' -m $files }
    }
    $version = Get-PkgVersion
    if ($version -eq $oldVersion) {
      throw "the pre-commit hook did not bump the version (still $version). Is husky installed? Run npm install."
    }
    Write-Host "$oldVersion -> $version"
  }

  Step "2/7 Build $version (Vimperium keeps running)"
  Invoke-Checked { npm run dist:win }

  Step '3/7 Check build output'
  $installer = Join-Path $repo "release\Vimperium Setup $version.exe"
  if (-not (Test-Path -LiteralPath $installer)) { throw "$installer not found, did the build fail?" }
  Write-Host $installer

  Step '4/7 Stop Vimperium and Newbro'
  if ($found = Get-Process -Name $appProcesses -ErrorAction SilentlyContinue) {
    Write-Host "Stopping $(($found | ForEach-Object ProcessName | Sort-Object -Unique) -join ' and ')"
    # Stopped outright: Windows has no message that quits the whole app, and closing its
    # windows one at a time makes it reopen only the last one next time.
    # The Chromium helpers are Vimperium.exe too and die with the main process, so "process not
    # found" for some of them is expected. A killed process gets its exit code at once but stays
    # in the process list until Windows has torn it down (~100-200ms for the browser process,
    # longer with many tabs), and Wait-Process counts it as exited and returns without waiting,
    # so poll until the list is actually empty. Killing again each round also catches a helper
    # the main process respawned just before it died.
    $deadline = (Get-Date).AddSeconds(15)
    while ($left = Get-Process -Name $appProcesses -ErrorAction SilentlyContinue) {
      if ((Get-Date) -gt $deadline) {
        throw "$(($left | ForEach-Object ProcessName | Sort-Object -Unique) -join ', ') still running after 15s (pid $(($left | ForEach-Object Id) -join ', '))"
      }
      Stop-Process -Name $appProcesses -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 100
    }
  } else {
    Write-Host 'Vimperium and Newbro are not running'
  }

  Step '5/7 Install silently'
  # NSIS is oneClick: false, per-user, so /S is an unattended install into the folder recorded
  # under the GUID (see Get-InstalledExe). It does not launch the app.
  $setup = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
  if ($setup.ExitCode -ne 0) { throw "installer exited with code $($setup.ExitCode)" }

  Step '6/7 Relaunch'
  # Read again: on a machine with no previous install the installer has only now recorded it.
  $exe = Get-InstalledExe
  if (-not (Test-Path -LiteralPath $exe)) { throw "$exe not found after install" }
  $installed = Get-ExeVersion $exe
  if ($installed -ne $version) { throw "the installed app reports $installed, expected $version" }
  # Through Explorer, so Vimperium starts from the user's shell rather than as a child of this
  # script. A shell an agent runs this from can have a stale sandboxed view of %APPDATA%, and a
  # child inherits it: Vimperium then reads an old runwa-settings.json and its palettes stop
  # matching Runwa's window. Explorer's exit code means nothing, so it isn't checked.
  Start-Process -FilePath explorer.exe -ArgumentList "`"$exe`""

  Step '7/7 Push'
  # Last on purpose: the new build is already running, so a failed push (offline, remote moved
  # on) costs nothing but a retry. -u origin HEAD also covers a branch with no upstream yet.
  git push -u origin HEAD
  if ($LASTEXITCODE -ne 0) { throw "$version is installed, but the push failed" }

  Write-Host "`nShipped $version to $exe (log: $log)" -ForegroundColor Green
}
finally {
  Pop-Location
}
