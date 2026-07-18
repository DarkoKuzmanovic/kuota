#!/bin/sh
# Remove the Kuota Plasma 6 widget package and its cache.
# Usage: scripts/uninstall.sh

package_id="io.github.darkokuzmanovic.kuota"
cache_dir="$HOME/.cache/kuota"

# Remove with the explicit package type. Without -t, kpackagetool6 -r only
# removes the kpackage/generic/ path and leaves the plasma/plasmoids/ copy
# that Plasma actually loads — so an untyped uninstall silently leaves a
# stale widget installed. -t Plasma/Applet removes the loaded copy.
if kpackagetool6 -t Plasma/Applet -r "$package_id" 2>/dev/null; then
    printf "Removed %s\n" "$package_id"
else
    printf "Package %s was not installed or removal produced a warning; continuing.\n" "$package_id"
fi

if [ -d "$cache_dir" ]; then
    rm -rf "$cache_dir"
    printf "Removed %s\n" "$cache_dir"
else
    printf "Cache %s was already absent; skipping.\n" "$cache_dir"
fi
