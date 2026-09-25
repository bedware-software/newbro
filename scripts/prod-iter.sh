#!/bin/zsh
# Build Newbro, reinstall it over the local prod install and relaunch it (macOS).
# Windows counterpart: scripts/prod-iter.ps1.
#
#   scripts/prod-iter.sh [commit message]
#
# The order is deliberate. Commit first: the husky pre-commit hook bumps the patch version,
# and that number is the only way to tell the new build from the old one. Build while Newbro
# keeps running (the build only writes to out/ and release/). Stop it only for the few
# seconds the install takes. Push last, once the new build is running.

set -euo pipefail

cd "${0:A:h:h}"

step() { print "\n\e[1m==> $*\e[0m" }
die()  { print -u2 "\e[31mprod-iter: $*\e[0m"; exit 1 }
pkg_version() { node -p "require('./package.json').version" }
bundle_version() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" }
newbro_running() { pgrep -x Newbro >/dev/null }

# pgrep -x Newbro matches only the installed app's main process: helpers are
# "Newbro Helper ...", and an `npm run dev` instance runs as "Electron".

log="$HOME/Library/Application Support/Newbro/newbro.log"

case $(uname -m) in
  arm64)  arch=arm64; built=release/mac-arm64/Newbro.app ;;
  x86_64) arch=x64;   built=release/mac/Newbro.app ;;
  *)      die "unsupported architecture $(uname -m)" ;;
esac

# Install to wherever the app runs from, unless that is the build output itself.
app=/Applications/Newbro.app
pid=$(pgrep -x Newbro | head -1 || true)
if [[ -n $pid ]]; then
  running=$(ps -o comm= -p "$pid")
  running=${running%/Contents/MacOS/Newbro}
  [[ $running == /*.app && ${running:A} != ${built:A} ]] && app=$running
fi

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

step "2/7 Build $version for $arch (Newbro keeps running)"
# Only this Mac's .app: without --<arch> --dir electron-builder also packs a dmg and a zip.
npm run dist:mac -- --$arch --dir

step "3/7 Check build output"
[[ -d $built ]] || die "$built not found, did the build fail?"
built_version=$(bundle_version "$built")
[[ $built_version == $version ]] || die "$built is $built_version, expected $version"
print "$built is $built_version"

step "4/7 Stop Newbro"
if newbro_running; then
  print "Quitting $app"
  osascript -e 'quit app "Newbro"' >/dev/null || print "osascript quit failed, waiting anyway"
  for i in {1..20}; do newbro_running || break; sleep 0.5; done
  if newbro_running; then
    print "Still running after 10s, force-killing"
    pkill -9 -x Newbro
    sleep 1
    ! newbro_running || die "Newbro survived pkill -9"
  fi
else
  print "Newbro is not running"
fi

step "5/7 Install to $app"
# Replace the whole bundle: files the new version dropped would otherwise linger inside it and
# break the code-signature seal. ditto keeps the framework symlinks and xattrs intact. The old
# bundle is parked, not deleted, until the copy lands, so a failed copy can't leave the
# machine without a Newbro.
parked=$(mktemp -d)/Newbro.app
[[ -d $app ]] && mv "$app" "$parked"
if ! ditto "$built" "$app"; then
  rm -rf "$app"
  [[ -d $parked ]] && mv "$parked" "$app" && open "$app"
  die "ditto failed, the previous Newbro is back in place"
fi
rm -rf "${parked:h}"

step "6/7 Relaunch"
installed=$(bundle_version "$app")
[[ $installed == $version ]] || die "the installed app reports $installed, expected $version"
open "$app"
for i in {1..20}; do newbro_running && break; sleep 0.5; done
newbro_running || die "Newbro did not start, check $log"

step "7/7 Push"
# Last on purpose: the new build is already running, so a failed push (offline, remote moved
# on) costs nothing but a retry. -u origin HEAD also covers a branch with no upstream yet.
git push -u origin HEAD || die "$version is installed, but the push failed"

print "\n\e[32mShipped $version to $app\e[0m (log: $log)"
