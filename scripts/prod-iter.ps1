# Build Newbro, reinstall it over the local prod install and relaunch it (Windows).
# macOS counterpart: scripts/prod-iter.sh.
#
#   scripts\prod-iter.ps1 [commit message]
#
# The order is deliberate. Commit first: the husky pre-commit hook bumps the patch version,
# and that number is the only way to tell the new build from the old one. Build while the
# app keeps running (the build only writes to out\ and release\). Stop the app only for the
# few seconds the install takes.
#
# Get-Process Newbro matches only the installed app: an `npm run dev` instance runs as
# electron.exe and is never touched.

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

$repo = Split-Path $PSScriptRoot -Parent
Push-Location $repo
try {
  Step '1/6 Commit'
  $oldVersion = Get-PkgVersion
  $status = git status --porcelain
  if ($LASTEXITCODE -ne 0) { throw 'git status failed' }
  if (-not $status) {
    Write-Host "Working tree is clean: nothing new to ship, the version stays $oldVersion."
    $answer = Read-Host "Rebuild and reinstall $oldVersion anyway? [y/N]"
    if ($answer -notmatch '^[yY]') { return }
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

  Step "2/6 Build $version (Newbro keeps running)"
  Invoke-Checked { npm run dist:win }

  Step '3/6 Check build output'
  $installer = Join-Path $repo "release\Newbro Setup $version.exe"
  if (-not (Test-Path -LiteralPath $installer)) { throw "$installer not found, did the build fail?" }
  Write-Host $installer

  Step '4/6 Stop Newbro'
  $exe = Join-Path $env:LOCALAPPDATA 'Programs\Newbro\Newbro.exe'
  $running = Get-Process Newbro -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($running) {
    # Relaunch from wherever the app runs from, unless that is a build inside the repo.
    if ($running.Path -and -not $running.Path.StartsWith($repo, 'OrdinalIgnoreCase')) { $exe = $running.Path }
    Write-Host "Stopping $($running.Path)"
    # "Process not found" is expected here: killing the main process takes its children down.
    Stop-Process -Name Newbro -Force -ErrorAction SilentlyContinue
    Wait-Process -Name Newbro -Timeout 15 -ErrorAction SilentlyContinue
    if (Get-Process Newbro -ErrorAction SilentlyContinue) { throw 'Newbro is still running after 15s' }
  } else {
    Write-Host 'Newbro is not running'
  }

  Step '5/6 Install silently'
  # NSIS is oneClick: false, per-user, so /S is an unattended install into
  # %LOCALAPPDATA%\Programs\Newbro. It does not launch the app.
  $setup = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
  if ($setup.ExitCode -ne 0) { throw "installer exited with code $($setup.ExitCode)" }

  Step '6/6 Relaunch'
  if (-not (Test-Path -LiteralPath $exe)) { throw "$exe not found after install" }
  Start-Process -FilePath $exe
  $installed = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
  if ($installed -ne $version -and $installed -ne "$version.0") {
    throw "the installed app reports $installed, expected $version"
  }
  $log = Join-Path $env:APPDATA 'Newbro\newbro.log'
  Start-Sleep -Seconds 4
  if (-not (Get-Process Newbro -ErrorAction SilentlyContinue)) { throw "Newbro did not start, check $log" }
  # The log is truncated on every start; a fresh "--- Newbro started at ... ---" confirms it.
  if (Test-Path -LiteralPath $log) {
    Write-Host "Log: $(Get-Content -LiteralPath $log -TotalCount 1)"
  } else {
    Write-Host "No log yet at $log"
  }

  Write-Host "`nShipped $version to $exe" -ForegroundColor Green
}
finally {
  Pop-Location
}
