---
name: prod-iter
description: Silently update prod from current state (macOS or Windows)
---

# build, install, relaunch

The user's standard "ship it to my own machine and dogfood it" loop after finishing a
feature. They are usually *using Newbro right now* while you run this, so the ordering
below is not arbitrary: it keeps the app alive through the slow part and only takes it
down for the ~10 seconds the install needs.

Run the whole cycle end-to-end without asking for confirmation between steps — `PROD ITER`
is the approval. Report failures with the actual output instead of silently retrying.

## Pick the platform

Check the platform in your environment info and follow only that platform's blocks below:
`win32` → **Windows** (PowerShell), `darwin` → **macOS** (zsh/bash). The steps and their
order are the same on both; only the commands differ. On any other platform, say this
skill doesn't cover it and stop.

| | Windows | macOS |
|---|---|---|
| Build script | `npm run dist:win` | `npm run dist:mac` |
| Build output to install | `release\Newbro Setup <version>.exe` | `release/mac-arm64/Newbro.app` (Intel: `release/mac/Newbro.app`) |
| Installed app | `%LOCALAPPDATA%\Programs\Newbro\Newbro.exe` | `/Applications/Newbro.app` |
| Prod log | `%APPDATA%\Newbro\newbro.log` | `~/Library/Application Support/Newbro/newbro.log` |

## The cycle

### 1. Commit everything FIRST

```bash
git add -A
git commit -m "<what changed>"
```

This has to happen *before* the build. The husky `.husky/pre-commit` hook runs
`npm version patch --no-git-tag-version`, so the commit is what produces the new version
number the build will ship — and that version number is the user's only signal that the new
bits actually landed. Build first and you ship the *old* version over an identical installed
version, with no way to tell them apart. (This has really happened: 1.1.137 shipped over
1.1.137 with the fix still uncommitted.)

Commit even work-in-progress or possibly-broken code. Each iteration being a git checkpoint
is a feature — `git checkout` makes rollback trivial, and the user would rather have a
restorable checkpoint than a tidy history.

If the tree is already clean there is nothing new to ship and no version bump will happen —
say so and ask before rebuilding, rather than reinstalling the identical version.

### 2. Build with the app still running

**Windows**

```powershell
npm run dist:win
```

**macOS**

```bash
npm run dist:mac
```

(= `electron-vite build && electron-builder --win --x64` / `--mac`.) This is the long step —
start it and wait for it (give the command a generous timeout, several minutes). **Do not
kill Newbro before this.** The build only writes to the dev repo's `out/` and `release/`;
the installed app runs from a different location with no file lock. Only the *install*
needs the app dead, so the user keeps browsing throughout.

On macOS the build ad-hoc signs the app and skips notarization — both expected for a local
build, not errors.

### 3. Locate the build output

Take `<version>` from `package.json` after the commit — that is the bumped one.

**Windows** — the installer is `release\Newbro Setup <version>.exe`, or pick the newest:

```powershell
Get-ChildItem "release\Newbro Setup *.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
```

**macOS** — install the unpacked `.app` electron-builder leaves next to the DMG and zip, not
the DMG itself. The folder is named after the architecture. Confirm it carries the new
version before touching the installed app:

```bash
ls -d release/mac*/Newbro.app
defaults read "$PWD/release/mac-arm64/Newbro.app/Contents/Info.plist" CFBundleShortVersionString
```

`release/mac-arm64/` is overwritten by every build, so a stale version here means the build
didn't run, not that you picked the wrong file.

### 4. Only now: capture the app path and stop the app

**Windows**

```powershell
Get-Process Newbro -ErrorAction SilentlyContinue | Select-Object -Expand Path
Stop-Process -Name Newbro -Force -ErrorAction SilentlyContinue
```

**macOS**

```bash
APP=$(ps -o comm= -p "$(pgrep -x Newbro | head -1)" 2>/dev/null | sed 's#/Contents/MacOS/Newbro$##')
APP=${APP:-/Applications/Newbro.app}
echo "$APP"
osascript -e 'quit app "Newbro"'
for i in {1..20}; do pgrep -x Newbro >/dev/null || break; sleep 0.5; done
pgrep -x Newbro >/dev/null && pkill -9 -x Newbro
```

Grab the path before stopping — it is where you install to and relaunch from. "Process not
found" (or an empty `pgrep`) is fine; it just means the app was not running. On macOS, ask
the app to quit normally and force-kill only if it is still alive ~10 seconds later.
`pgrep -x Newbro` matches only the installed app's main process — helpers are
`Newbro Helper …`, and an `npm run dev` instance runs as `Electron` — so the dev instance is
never touched. The same holds on Windows, where dev runs as `electron.exe`.

On macOS, shell variables don't survive between separate tool calls: run steps 4–6 as one
command, or re-derive `$APP` in each.

### 5. Install silently

**Windows**

```powershell
Start-Process -FilePath "release\Newbro Setup <version>.exe" -ArgumentList "/S" -Wait
```

NSIS is configured `oneClick: false`, `perMachine: false`, so `/S` performs an unattended
per-user install into `%LOCALAPPDATA%\Programs\Newbro`. Never run the interactive wizard —
it would sit there waiting for clicks. Silent install does **not** auto-launch the app.

Leave the NSIS settings in `package.json` alone. Silent is a command-line concern here; the
installer published to GitHub for real users stays interactive on purpose.

**macOS**

```bash
rm -rf "$APP" && ditto release/mac-arm64/Newbro.app "$APP"
```

Replace the whole bundle rather than copying over the old one: files the new version dropped
would linger inside it and break its code-signature seal. Use `ditto`, not `cp -R` — it keeps
the Electron framework symlinks and extended attributes intact. Don't mount the DMG; it holds
the same `.app`. A locally built app has no quarantine flag, so Gatekeeper launches it
without a prompt.

### 6. Relaunch and verify the version moved

**Windows**

```powershell
Start-Process "$env:LOCALAPPDATA\Programs\Newbro\Newbro.exe"
(Get-Item "$env:LOCALAPPDATA\Programs\Newbro\Newbro.exe").VersionInfo.ProductVersion
```

**macOS**

```bash
open "$APP"
defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString
sleep 4 && pgrep -x Newbro && head -1 "$HOME/Library/Application Support/Newbro/newbro.log"
```

The version readout (`ProductVersion` on Windows, `CFBundleShortVersionString` on macOS) must
match the freshly bumped `package.json` version — that is the proof the new build is what is
now running, and it beats eyeballing the About dialog. If it still shows the old number, the
install did not take: check the path you installed from and whether step 1 actually bumped
the version.

## Notes

- There is no manual `electron-rebuild` / native-module step; electron-builder handles native
  dependencies itself during the build.
- Prod logs (paths in the table above; dev instance: the `Newbro Dev` folder next to them) are
  truncated on every start — a fresh `--- Newbro started at ... ---` line at the top confirms
  the relaunch. Read it yourself when something looks wrong instead of asking the user.
- `release/` accumulates every past build — `Newbro Setup *.exe` on Windows,
  `Newbro-*-arm64.dmg` / `-mac.zip` on macOS. That is expected; don't clean it up unless
  asked.
