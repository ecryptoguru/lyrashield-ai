#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

git init --quiet --bare "$tmp/origin.git"
git init --quiet -b main "$tmp/source"
git -C "$tmp/source" config user.email ci-fixture@example.invalid
git -C "$tmp/source" config user.name 'CI fixture'
printf 'fixture\n' > "$tmp/source/README.md"
git -C "$tmp/source" add README.md
git -C "$tmp/source" commit --quiet -m baseline
revision=$(git -C "$tmp/source" rev-parse HEAD)
git -C "$tmp/source" remote add origin "$tmp/origin.git"
git -C "$tmp/source" push --quiet origin main
git clone --quiet "$tmp/origin.git" "$tmp/engine"

mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'GH'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = api ] || exit 90
shift
paginate=false
endpoint=""
while (($#)); do
  case "$1" in
    --paginate) paginate=true; shift ;;
    *) endpoint=$1; shift ;;
  esac
done
[ "$paginate" = true ] || exit 91
[[ "$endpoint" == repos/example/engine/commits/*/check-runs ]] || exit 92
# Simulate gh --paginate: each response page is emitted as one JSON document.
jq -c '.[]' "$GH_CHECK_PAGES"
GH
chmod +x "$tmp/bin/gh"

cat > "$tmp/pages.json" <<'JSON'
[
  {"check_runs":[{"name":"verify","status":"completed","conclusion":"success"}]},
  {"check_runs":[{"name":"Build and smoke-test sandbox image","status":"completed","conclusion":"success"}]}
]
JSON

PATH="$tmp/bin:$PATH" GH_CHECK_PAGES="$tmp/pages.json" \
  bash "$repo_root/.github/scripts/verify-engine-revision.sh" "$tmp/engine" "$revision" example/engine

cat > "$tmp/pages.json" <<'JSON'
[
  {"check_runs":[{"name":"verify","status":"completed","conclusion":"success"}]},
  {"check_runs":[{"name":"Build and smoke-test sandbox image","status":"completed","conclusion":"failure"}]}
]
JSON
if PATH="$tmp/bin:$PATH" GH_CHECK_PAGES="$tmp/pages.json" \
  bash "$repo_root/.github/scripts/verify-engine-revision.sh" "$tmp/engine" "$revision" example/engine \
  > "$tmp/rejected.stdout" 2> "$tmp/rejected.stderr"; then
  echo 'expected the failed paginated engine check to block provenance verification' >&2
  exit 1
fi
grep -Fq "does not have a successful 'Build and smoke-test sandbox image' check" "$tmp/rejected.stderr"

echo 'Engine check-run pagination contract passed.'
