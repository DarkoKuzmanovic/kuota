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
. "$root_dir/scripts/build-source.sh"

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
