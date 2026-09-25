#!/bin/zsh
# Build Newbro, reinstall it over the local prod install and relaunch it (macOS).
# Windows counterpart: scripts/prod-iter.ps1.
#
#   scripts/prod-iter.sh [commit message]
#
# The order is deliberate. Commit first: the husky pre-commit hook bumps the patch version,
# and that number is the only way to tell the new build from the old one. Build while the
# app keeps running (the build only writes to out/ and release/). Stop the app only for the
# few seconds the install takes.

set -euo pipefail

cd "${0:A:h:h}"

step() { print "\n\e[1m==> $*\e[0m" }
die()  { print -u2 "\e[31mprod-iter: $*\e[0m"; exit 1 }
pkg_version() { node -p "require('./package.json').version" }
bundle_version() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" }
newbro_running() { pgrep -x Newbro >/dev/null }

# pgrep -x Newbro matches only the installed app's main process: helpers are
# "Newbro Helper ...", and an `npm run dev` instance runs as "Electron".

step "1/6 Commit"
old_version=$(pkg_version)
if [[ -z $(git status --porcelain) ]]; then
  print "Working tree is clean: nothing new to ship, the version stays $old_version."
  read -q "?Rebuild and reinstall $old_version anyway? [y/N] " || { print; exit 0 }
  print
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

step "2/6 Build $version (Newbro keeps running)"
npm run dist:mac

step "3/6 Check build output"
if [[ $(uname -m) == arm64 ]]; then built=release/mac-arm64/Newbro.app; else built=release/mac/Newbro.app; fi
[[ -d $built ]] || die "$built not found, did the build fail?"
built_version=$(bundle_version "$built")
[[ $built_version == $version ]] || die "$built is $built_version, expected $version"
print "$built is $built_version"

step "4/6 Stop Newbro"
app=/Applications/Newbro.app
pid=$(pgrep -x Newbro | head -1 || true)
if [[ -n $pid ]]; then
  running=$(ps -o comm= -p "$pid")
  running=${running%/Contents/MacOS/Newbro}
  # Install to wherever the app runs from, unless that is the build output itself.
  [[ $running == *.app && ${running:A} != ${built:A} ]] && app=$running
  print "Quitting $running"
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

step "5/6 Install to $app"
[[ $app == /*.app ]] || die "refusing to replace $app"
# Replace the whole bundle: files the new version dropped would otherwise linger inside it
# and break the code-signature seal. ditto keeps the framework symlinks and xattrs intact.
rm -rf "$app"
ditto "$built" "$app"

step "6/6 Relaunch"
open "$app"
installed=$(bundle_version "$app")
[[ $installed == $version ]] || die "the installed app reports $installed, expected $version"
log="$HOME/Library/Application Support/Newbro/newbro.log"
for i in {1..20}; do newbro_running && break; sleep 0.5; done
newbro_running || die "Newbro did not start, check $log"
# The log is truncated on every start; a fresh "--- Newbro started at ... ---" confirms it.
sleep 2
[[ -f $log ]] && print "Log: $(head -1 "$log")" || print "No log yet at $log"

print "\n\e[32mShipped $version to $app\e[0m"
