#!/usr/bin/env bash
# Publishes all Shiftwork packages to npm. Core goes first, because the other packages depend on it.
set -euo pipefail
cd "$(dirname "$0")/.."

user=$(npm whoami) || { echo "Not logged in to npm: run 'npm login' first"; exit 1; }
echo "npm user: $user"

# A name that already exists must be ours; otherwise npm answers with a confusing 403/404.
for pkg in core cli pi opencode; do
  name=$(node -p "require('./packages/$pkg/package.json').name")
  owners=$(npm owner ls "$name" 2>/dev/null || true)
  if [[ -n "$owners" ]] && ! grep -q "^$user " <<<"$owners"; then
    echo "$name already belongs to: $owners"; exit 1
  fi
done

for pkg in core cli pi opencode; do
  name=$(node -p "require('./packages/$pkg/package.json').name")
  version=$(node -p "require('./packages/$pkg/package.json').version")
  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "skip $name@$version (already published)"
    continue
  fi
  echo "publish $name@$version"
  npm publish --workspace "packages/$pkg" --access public "$@"
done
