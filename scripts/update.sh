#!/bin/sh
# Upgrade the Kuota Plasma 6 widget package.
# Usage: scripts/update.sh

set -e

root_dir=$(cd "$(dirname "$0")/.." && pwd)
cd "$root_dir"

package_id="io.github.darkokuzmanovic.kuota"
artifact="dist/artifact/kuota-v0.1.0.plasmoid"

if [ ! -f "$artifact" ]; then
    printf "Artifact missing; building...\n"
    npm run build:artifact
fi

kpackagetool6 -u "$artifact"
printf "Upgraded %s. Restart Plasma or re-add the widget to load the new version.\n" "$package_id"
