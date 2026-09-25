---
name: prod-iter
description: Commit, build, reinstall and relaunch Newbro, then push, via scripts/prod-iter.sh (macOS) or scripts/prod-iter.ps1 (Windows)
---

Run `scripts/prod-iter.sh "<commit message>"` on macOS or `powershell -ExecutionPolicy Bypass -File scripts\prod-iter.ps1 "<commit message>"` on Windows from the repo root, in the background (the build takes minutes). Don't re-implement or pre-run any of its steps. Report the `Shipped <version>` line, or the failing step and its output.
