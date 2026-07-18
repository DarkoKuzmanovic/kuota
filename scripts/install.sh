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
artifact="dist/artifact/kuota-v0.1.0.plasmoid"

if [ ! -f "$artifact" ]; then
    printf "Artifact missing; building...\n"
    npm run build:artifact
fi

if kpackagetool6 -i "$artifact" 2>/dev/null; then
    printf "Installed %s\n" "$package_id"
else
    if kpackagetool6 -u "$artifact" 2>/dev/null; then
        printf "Upgraded %s\n" "$package_id"
    else
        printf "Failed to install %s\n" "$package_id" >&2
        exit 1
    fi
fi
