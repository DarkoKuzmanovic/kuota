#!/bin/sh
# Upgrade the Kuota Plasma 6 widget package.
# Usage: scripts/update.sh

set -e

# Resolve the repo root without capturing cd side effects. POSIX `cd`
# prints the resolved directory to stdout when CDPATH is set and a relative
# path is resolved through it; redirecting cd's stdout keeps that print out
# of the command substitution so only `pwd`'s output is captured.
root_dir=$(cd "$(dirname "$0")/.." >/dev/null && pwd)
cd "$root_dir"

package_id="io.github.darkokuzmanovic.kuota"
# Derive the artifact name from package.json so a version bump can't silently
# install a stale artifact (the version string appears nowhere else in this
# script). Pure POSIX grep+cut — no node/jq dependency on the dep-free sh layer.
version=$(grep '^  "version":' package.json | cut -d'"' -f4)
artifact="dist/artifact/kuota-v${version}.plasmoid"

if [ ! -f "$artifact" ]; then
    printf "Artifact missing; building...\n"
    npm run build:artifact
fi

# Upgrade with the explicit package type — Plasma loads from plasma/plasmoids/,
# not kpackage/generic/ where an untyped upgrade would land. See install.sh.
kpackagetool6 -t Plasma/Applet -u "$artifact"
printf "Upgraded %s. Restart Plasma or re-add the widget to load the new version.\n" "$package_id"
