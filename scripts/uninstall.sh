#!/bin/sh
# Remove the Kuota Plasma 6 widget package and its cache.
# Usage: scripts/uninstall.sh

package_id="io.github.darkokuzmanovic.kuota"
cache_dir="$HOME/.cache/kuota"

if kpackagetool6 -r "$package_id" 2>/dev/null; then
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
