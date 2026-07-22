#!/bin/sh
# Install or upgrade the Kuota Plasma 6 widget package.
# Usage: scripts/install.sh

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
# script). Use node for the read rather than grep+cut: a strict regex like
# `grep '^  "version":'` assumes exactly two leading spaces and silently
# returns empty if package.json is reformatted (column-0 keys, tabs, or a
# different indent), causing the install path to diverge from the just-built
# filename and producing a cryptic "Plugin %1 is not installed" from
# kpackagetool6 — easier to fail loud via node than to debug from a
# substring search. node is already required by `npm run build:artifact`
# which this script invokes, so no new dependency is introduced.
version=$(node -p "require('./package.json').version")
artifact="dist/artifact/kuota-v${version}.plasmoid"

if [ ! -f "$artifact" ]; then
    printf "Artifact missing; building...\n"
    npm run build:artifact
fi

# Install with the explicit package type. Without -t, kpackagetool6 installs
# to kpackage/generic/, but Plasma loads plasmoids from plasma/plasmoids/ —
# so an untyped install never reaches the running widget. -t Plasma/Applet
# targets the path Plasma actually loads from.
# Stderr is NOT suppressed: the "Plugin %1 is not installed" message from
# kpackagetool6 has a substituted plugin name that is the most useful
# diagnostic when the install path diverges from the just-built artifact
# (a version-bump/grep mismatch surfaces here, not as an empty error).
if kpackagetool6 -t Plasma/Applet -i "$artifact"; then
    printf "Installed %s\n" "$package_id"
else
    if kpackagetool6 -t Plasma/Applet -u "$artifact"; then
        printf "Upgraded %s\n" "$package_id"
    else
        printf "Failed to install %s\n" "$package_id" >&2
        exit 1
    fi
fi
