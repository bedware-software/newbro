#!/bin/zsh
# Build Vimperium, reinstall it over the local prod install and relaunch it (macOS).
# Windows counterpart: scripts/prod-iter.ps1.
#
#   scripts/prod-iter.sh [commit message]
#
# The order is deliberate. Commit first: the husky pre-commit hook bumps the patch version,
# and that number is the only way to tell the new build from the old one. Build while Vimperium
# keeps running (the build only writes to out/ and release/). Stop it only for the few
# seconds the install takes. Push last, once the new build is running.

set -euo pipefail

cd "${0:A:h:h}"

step() { print "\n\e[1m==> $*\e[0m" }
die()  { print -u2 "\e[31mprod-iter: $*\e[0m"; exit 1 }
pkg_version() { node -p "require('./package.json').version" }
bundle_version() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" }
running() { pgrep -x "$1" >/dev/null }
any_running() { running Vimperium || running Newbro }
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

# pgrep -x Vimperium matches only the installed app's main process: helpers are
# "Vimperium Helper ...", and an `npm run dev` instance runs as "Electron".
#
# Newbro is the app's name before the rename. Its install is still around until the first
# Vimperium install replaces it, and it must not be running then: the first Vimperium launch
# moves Newbro's data into its own folder.

log="$HOME/Library/Application Support/Vimperium/vimperium.log"

case $(uname -m) in
  arm64)  arch=arm64; built=release/mac-arm64/Vimperium.app ;;
  x86_64) arch=x64;   built=release/mac/Vimperium.app ;;
  *)      die "unsupported architecture $(uname -m)" ;;
esac

# The bundle a running app's main process is in, or nothing when it is not running or runs
# from the build output in release/.
running_bundle() {
  local pid=$(pgrep -x "$1" | head -1 || true) bundle
  [[ -n $pid ]] || return 0
  bundle=$(ps -o comm= -p "$pid")
  bundle=${bundle%/Contents/MacOS/$1}
  [[ $bundle == /*.app && ${bundle:A} != ${PWD:A}/release/* ]] && print -r -- "$bundle"
  return 0
}

# Install to wherever the app runs from. A running Newbro is replaced by a Vimperium.app in
# its folder, so /Applications/Newbro.app becomes /Applications/Vimperium.app.
app=/Applications/Vimperium.app
legacy_app=/Applications/Newbro.app
running_app=$(running_bundle Vimperium)
running_legacy=$(running_bundle Newbro)
[[ -n $running_legacy ]] && legacy_app=$running_legacy && app=${running_legacy:h}/Vimperium.app
[[ -n $running_app ]] && app=$running_app

step "1/7 Commit"
old_version=$(pkg_version)
if [[ -z $(git status --porcelain) ]]; then
  installed=$([[ -d $app ]] && bundle_version "$app" || print none)
  # A clean tree still has something to ship when the last commit (and its version bump)
  # never made it into the installed app.
  if [[ $installed == $old_version ]]; then
    print "Working tree is clean and $app is already $old_version."
    [[ -t 0 ]] && read -q "?Rebuild and reinstall $old_version anyway? [y/N] " || { print; exit 0 }
    print
  else
    print "Working tree is clean, shipping $old_version over the installed $installed."
  fi
  version=$old_version
else
  git add -A
  if (( $# )); then
    git commit -m "$*"
  else
    git commit -m "Prod iter checkpoint" -m "$(git diff --cached --name-status)"
  fi
  version=$(pkg_version)
  [[ $version != $old_version ]] ||
    die "the pre-commit hook did not bump the version (still $version). Is husky installed? Run npm install."
  print "$old_version -> $version"
fi

step "2/7 Build $version for $arch (Vimperium keeps running)"
# Only this Mac's .app: without --<arch> --dir electron-builder also packs a dmg and a zip.
npm run dist:mac -- --$arch --dir

step "3/7 Check build output"
[[ -d $built ]] || die "$built not found, did the build fail?"
built_version=$(bundle_version "$built")
[[ $built_version == $version ]] || die "$built is $built_version, expected $version"
print "$built is $built_version"

step "4/7 Stop Vimperium and Newbro"
# Quit politely first, so each app saves its session, and only what is actually running:
# osascript asks "Where is Newbro?" for an app it can't find.
for name in Vimperium Newbro; do
  running $name || continue
  print "Quitting $name"
  osascript -e "quit app \"$name\"" >/dev/null || print "osascript quit $name failed, waiting anyway"
done
for i in {1..20}; do any_running || break; sleep 0.5; done
for name in Vimperium Newbro; do
  running $name || continue
  print "$name still running after 10s, force-killing"
  pkill -9 -x $name
  sleep 1
  ! running $name || die "$name survived pkill -9"
done
print "Vimperium and Newbro are not running"

step "5/7 Install to $app"
# Replace the whole bundle: files the new version dropped would otherwise linger inside it and
# break the code-signature seal. ditto keeps the framework symlinks and xattrs intact. The old
# bundle is parked, not deleted, until the copy lands, so a failed copy can't leave the
# machine without a Vimperium.
parked=$(mktemp -d)/Vimperium.app
[[ -d $app ]] && mv "$app" "$parked"
if ! ditto "$built" "$app"; then
  rm -rf "$app"
  [[ -d $parked ]] && mv "$parked" "$app" && open "$app"
  die "ditto failed, the previous Vimperium is back in place"
fi
rm -rf "${parked:h}"

# Newbro.app goes once Vimperium.app is in place. Left behind it would sit next to it in
# Spotlight and Launchpad, and LaunchServices would keep offering it for links. It goes to the
# Trash, not away, so it can be put back: through Finder for Put Back, or /usr/bin/trash
# (macOS 15 and later) if Finder can't.
if [[ -d $legacy_app && ${legacy_app:A} != ${app:A} ]]; then
  print "Moving $legacy_app to the Trash"
  "$lsregister" -u "$legacy_app" || print "lsregister -u $legacy_app failed"
  if trashed=$(osascript -e 'on run argv' -e 'set target to POSIX file (item 1 of argv) as alias' \
      -e 'tell application "Finder" to set trashed to (delete target)' \
      -e 'return POSIX path of (trashed as alias)' -e 'end run' "$legacy_app"); then
    "$lsregister" -u "${trashed%/}" || print "lsregister -u $trashed failed"
  elif [[ -x /usr/bin/trash ]] && /usr/bin/trash "$legacy_app"; then
    print "Moved with /usr/bin/trash"
  else
    print "Could not move $legacy_app to the Trash; delete it by hand"
  fi
fi

step "6/7 Relaunch"
installed=$(bundle_version "$app")
[[ $installed == $version ]] || die "the installed app reports $installed, expected $version"
open "$app"
for i in {1..20}; do running Vimperium && break; sleep 0.5; done
running Vimperium || die "Vimperium did not start, check $log"

step "7/7 Push"
# Last on purpose: the new build is already running, so a failed push (offline, remote moved
# on) costs nothing but a retry. -u origin HEAD also covers a branch with no upstream yet.
git push -u origin HEAD || die "$version is installed, but the push failed"

print "\n\e[32mShipped $version to $app\e[0m (log: $log)"
