# Sourced from install.sh/update.sh after changing to the repository root.
# JSON parsing is independent of package.json formatting.
version=$(node -p "require('./package.json').version")
artifact="dist/artifact/kuota-v${version}.plasmoid"
# A previous same-version build is never evidence of current source freshness.
rm -f -- "$artifact"
npm run build:artifact
if [ ! -s "$artifact" ]; then
    printf 'Build did not produce a nonempty archive.\n' >&2
    exit 1
fi
