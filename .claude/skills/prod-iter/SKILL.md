---
name: prod-iter
description: Commit, build, reinstall and relaunch Vimperium, then push, via scripts/prod-iter.sh (macOS) or scripts/prod-iter.ps1 (Windows)
---

Run `scripts/prod-iter.sh "<commit message>"` on macOS or `powershell -ExecutionPolicy Bypass -File scripts\prod-iter.ps1 "<commit message>"` on Windows from the repo root, in the background (the build takes minutes). Don't re-implement or pre-run any of its steps. Report the `Shipped <version>` line, or the failing step and its output.

It also handles the move from Newbro, the app's old name. It quits a running Newbro as well as Vimperium, because the first Vimperium launch moves Newbro's data. On macOS it installs `/Applications/Vimperium.app` and then moves `Newbro.app` to the Trash. On Windows the installer upgrades Newbro's install in place. The app log is `~/Library/Application Support/Vimperium/vimperium.log` on macOS and `%APPDATA%\Vimperium\vimperium.log` on Windows.
