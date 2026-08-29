#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
action="$repo_root/action.yml"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

extract_gate() {
  awk '
    /^    - name: Build SARIF and evaluate gate$/ { step = 1; next }
    step && /^      run: \|$/ { run = 1; next }
    run && /^    - name: Archive SARIF$/ { exit }
    run { sub(/^        /, ""); print }
  ' "$action" > "$temp_dir/gate.sh"
}

init_fixture_repo() {
  local fixture_dir="$1"
  git init -q "$fixture_dir"
  git -C "$fixture_dir" config user.email "fixture@example.invalid"
  git -C "$fixture_dir" config user.name "Action fixture"
}

run_gate() {
  local fixture_dir="$1" expected_failed="$2" sarif_file="$3"
  local base_sha head_sha runner_temp output_file
  base_sha="$(git -C "$fixture_dir" rev-parse HEAD~1)"
  head_sha="$(git -C "$fixture_dir" rev-parse HEAD)"
  runner_temp="$fixture_dir/runner"
  output_file="$fixture_dir/output"
  mkdir -p "$runner_temp"
  git -C "$fixture_dir" diff --name-only -z "$base_sha" "$head_sha" > "$runner_temp/changed_files.txt"

  (
    cd "$fixture_dir"
    SECRETS_OUTCOME=success \
      BASE_SHA="$base_sha" \
      HEAD_SHA="$head_sha" \
      SEVERITY=HIGH \
      RUNNER_TEMP="$runner_temp" \
      GITHUB_OUTPUT="$output_file" \
      bash "$temp_dir/gate.sh"
  )

  grep -qx "failed=$expected_failed" "$output_file"
  cp "$runner_temp/lyrashield-results.sarif" "$sarif_file"
}

extract_gate

handler_fixture="$temp_dir/handler"
init_fixture_repo "$handler_fixture"
printf '%s\n' \
  'document.modelContext.registerTool("review", {}, async () => {' \
  '  return { ok: true }' \
  '})' > "$handler_fixture/tool.ts"
git -C "$handler_fixture" add tool.ts
git -C "$handler_fixture" commit -qm baseline
printf '%s\n' \
  'document.modelContext.registerTool("review", {}, async () => {' \
  '  confirm("anything can be typed here")' \
  '  return fetch("/api/reviews", { method: "POST" })' \
  '})' > "$handler_fixture/tool.ts"
git -C "$handler_fixture" add tool.ts
git -C "$handler_fixture" commit -qm mutation
run_gate "$handler_fixture" 1 "$temp_dir/handler.sarif"
jq -e '[.runs[0].results[] | select(.ruleId == "WEBMCP-COVERAGE-INCOMPLETE")] | length == 1' "$temp_dir/handler.sarif" >/dev/null

form_fixture="$temp_dir/form"
init_fixture_repo "$form_fixture"
printf '%s\n' '<form toolname="archive_record"><button>Archive</button></form>' > "$form_fixture/tool.html"
git -C "$form_fixture" add tool.html
git -C "$form_fixture" commit -qm baseline
printf '%s\n' \
  '<form toolname="archive_record"><button>Archive</button></form>' \
  '<script>fetch("/api/archive", { method: "DELETE" })</script>' > "$form_fixture/tool.html"
git -C "$form_fixture" add tool.html
git -C "$form_fixture" commit -qm mutation
run_gate "$form_fixture" 1 "$temp_dir/form.sarif"
jq -e '[.runs[0].results[] | select(.ruleId == "WEBMCP-COVERAGE-INCOMPLETE")] | length == 1' "$temp_dir/form.sarif" >/dev/null

safe_fixture="$temp_dir/safe"
init_fixture_repo "$safe_fixture"
printf '%s\n' \
  'document.modelContext.registerTool("review", {}, async () => {' \
  '  return { ok: true }' \
  '})' > "$safe_fixture/tool.ts"
git -C "$safe_fixture" add tool.ts
git -C "$safe_fixture" commit -qm baseline
printf '%s\n' \
  'document.modelContext.registerTool("review", {}, async () => {' \
  '  return { status: "ready" }' \
  '})' > "$safe_fixture/tool.ts"
git -C "$safe_fixture" add tool.ts
git -C "$safe_fixture" commit -qm safe
run_gate "$safe_fixture" 0 "$temp_dir/safe.sarif"
jq -e '[.runs[0].results[] | select(.ruleId == "WEBMCP-COVERAGE-INCOMPLETE")] | length == 0' "$temp_dir/safe.sarif" >/dev/null

echo "action WebMCP coverage fixtures passed"
