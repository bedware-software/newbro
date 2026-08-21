---
name: prod-iter
description: Ship the current working tree to this machine as a real packaged Windows build of Newbro — commit first (the pre-commit hook bumps the version), `npm run dist:win` while the app keeps running, kill + silent `/S` install, relaunch, verify the version moved. Use this whenever the user says `PROD ITER` (bare, all-caps — that phrase alone is the whole trigger, no arguments), and also when they ask in any other words to ship, install, or dogfood the current changes as a real installed build ("собери и поставь", "put the new version on my machine", "let's test this in prod"). Not for `npm run dev` — this skill is specifically the packaged-install loop.
---

# PROD ITER — build, install, relaunch

The user's standard "ship it to my own machine and dogfood it" loop after finishing a
feature. They are usually *using Newbro right now* while you run this, so the ordering
below is not arbitrary: it keeps the app alive through the slow part and only takes it
down for the ~10 seconds the installer needs.

Run the whole cycle end-to-end without asking for confirmation between steps — `PROD ITER`
is the approval. Report failures with the actual output instead of silently retrying.

## The cycle

### 1. Commit everything FIRST

```powershell
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

```powershell
npm run dist:win
```

(= `electron-vite build && electron-builder --win --x64`.) This is the long step — start it
and wait for it. **Do not kill Newbro before this.** The build only writes to the dev repo's
`out\` and `release\`; the installed app runs from `%LOCALAPPDATA%\Programs\Newbro`, a
different location with no file lock. Only the *install* needs the app dead, so the user
keeps browsing throughout.

### 3. Locate the installer

Output is `release\Newbro Setup <version>.exe`. Take `<version>` from `package.json` after
the commit (that is the bumped one), or pick the newest match:

```powershell
Get-ChildItem "release\Newbro Setup *.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
```

### 4. Only now: capture the exe path and kill the app

```powershell
Get-Process Newbro -ErrorAction SilentlyContinue | Select-Object -Expand Path
Stop-Process -Name Newbro -Force -ErrorAction SilentlyContinue
```

Grab the path before killing — it is where you relaunch from, and the installer overwrites
that same file in place. "Process not found" is fine; it just means the app was not running.

### 5. Install silently

```powershell
Start-Process -FilePath "release\Newbro Setup <version>.exe" -ArgumentList "/S" -Wait
```

NSIS is configured `oneClick: false`, `perMachine: false`, so `/S` performs an unattended
per-user install into `%LOCALAPPDATA%\Programs\Newbro`. Never run the interactive wizard —
it would sit there waiting for clicks. Silent install does **not** auto-launch the app.

Leave the NSIS settings in `package.json` alone. Silent is a command-line concern here; the
installer published to GitHub for real users stays interactive on purpose.

### 6. Relaunch and verify the version moved

```powershell
Start-Process "$env:LOCALAPPDATA\Programs\Newbro\Newbro.exe"
(Get-Item "$env:LOCALAPPDATA\Programs\Newbro\Newbro.exe").VersionInfo.ProductVersion
```

The `ProductVersion` readout must match the freshly bumped `package.json` version — that is
the proof the new build is what is now running, and it beats eyeballing the About dialog.
If it still shows the old number, the install did not take: check the installer path you ran
and whether step 1 actually bumped the version.

## Notes

- Newbro has no native addons, so there is no `electron-rebuild` / native-module step.
- Prod logs live at `%APPDATA%\Newbro\newbro.log` (dev: `%APPDATA%\Newbro Dev\newbro.log`),
  truncated on every start — a fresh `--- Newbro started at ... ---` line at the top confirms
  the relaunch. Read it yourself when something looks wrong instead of asking the user.
- `release\` accumulates every past `Newbro Setup *.exe`; that is expected, don't clean it up
  unless asked.
