#!/usr/bin/env bash
# Classify the unshipped main-branch gap per production target. PRs continue to
# use their event base/head diff directly in ci.yml.
set -euo pipefail

: "${HEAD_SHA:?HEAD_SHA is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

workspace="${GITHUB_WORKSPACE:-$PWD}"
classifier="${CLASSIFIER_SCRIPT:-$workspace/.github/scripts/classify-paths.sh}"
temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT

valid_sha() {
  [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]]
}

write_conservative_outputs() {
  local current_main="$1"
  GITHUB_OUTPUT="$GITHUB_OUTPUT" bash "$classifier" --force-all </dev/null
  printf 'current-main=%s\n' "$current_main" >> "$GITHUB_OUTPUT"
}

if ! valid_sha "$HEAD_SHA" || ! git -C "$workspace" cat-file -e "${HEAD_SHA}^{commit}" 2>/dev/null; then
  echo "::warning::Main SHA is unavailable; selecting all validation and release routes."
  write_conservative_outputs false
  exit 0
fi

# Main runs are serialized. A run already superseded before this read keeps full
# validation but holds release routing for the queued current-main run. If a new
# commit arrives after this read, its run will classify the remaining gap from
# the deployed markers after this run finishes.
if ! latest_main_response="$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/main" 2>/dev/null)"; then
  echo "::warning::Could not read current main; selecting all validation and release routes."
  write_conservative_outputs false
  exit 0
fi
if ! latest_main="$(jq -r '.object.sha // empty' <<<"$latest_main_response")"; then
  echo "::warning::Could not parse current main; selecting all validation and release routes."
  write_conservative_outputs false
  exit 0
fi
if ! valid_sha "$latest_main"; then
  echo "::warning::GitHub returned an invalid main SHA; selecting all validation and release routes."
  write_conservative_outputs false
  exit 0
fi
if [[ "$HEAD_SHA" != "$latest_main" ]]; then
  echo "::notice::This CI run is superseded by main ${latest_main}; deployment routes are held for the current run."
  write_conservative_outputs false
  exit 0
fi

read_marketing_sha() {
  local homepage marker
  homepage="$(curl --fail --silent --show-error --max-time 30 --max-filesize 2097152 \
    -H 'Cache-Control: no-cache' \
    "https://lyrashieldai.com/?cachebust=${HEAD_SHA}-${GITHUB_RUN_ID:-local}")" || return 1
  marker="$(printf '%s' "$homepage" | sed -n 's/.*<meta name="lyrashield-build-revision" content="\([0-9a-f]\{40\}\)".*/\1/p' | head -n 1)"
  valid_sha "$marker" || return 1
  printf '%s\n' "$marker"
}

read_azure_sha() {
  local deployments candidates deployment_id deployment_sha statuses success_logs log_url run_id run_details run_path run_sha conclusion
  deployments="$(gh api "repos/${GITHUB_REPOSITORY}/deployments?environment=azure-production&ref=main&per_page=100" 2>/dev/null)" || return 1
  jq -e 'type == "array"' >/dev/null 2>&1 <<<"$deployments" || return 1
  candidates="$(jq -r 'sort_by(.created_at) | reverse | .[] | [.id, .sha] | @tsv' <<<"$deployments")"

  # Environment history also contains admission and admin-operations jobs.
  # Only accept a successful production deploy whose status links to a known
  # code-release workflow and whose workflow-run SHA is the deployed SHA.
  while IFS=$'\t' read -r deployment_id deployment_sha; do
    [[ -n "$deployment_id" ]] || continue
    valid_sha "$deployment_sha" || continue
    if ! statuses="$(gh api "repos/${GITHUB_REPOSITORY}/deployments/${deployment_id}/statuses?per_page=100" 2>/dev/null)"; then
      continue
    fi
    jq -e 'type == "array"' >/dev/null 2>&1 <<<"$statuses" || continue
    success_logs="$(jq -r '.[0] | select(.state == "success") | .log_url // empty' <<<"$statuses")"
    while IFS= read -r log_url; do
      [[ -n "$log_url" ]] || continue
      if [[ "$log_url" =~ /actions/runs/([0-9]+)(/job/[0-9]+)?$ ]]; then
        run_id="${BASH_REMATCH[1]}"
      else
        continue
      fi
      if ! run_details="$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}" 2>/dev/null)"; then
        continue
      fi
      read -r run_path run_sha conclusion < <(jq -r '[.path // "", .head_sha // "", .conclusion // ""] | @tsv' <<<"$run_details")
      case "$run_path" in
        .github/workflows/release-production.yml|.github/workflows/deploy-azure.yml) ;;
        *) continue ;;
      esac
      if [[ "$conclusion" == success && "$run_sha" == "$deployment_sha" ]]; then
        printf '%s\n' "$deployment_sha"
        return 0
      fi
    done <<<"$success_logs"
  done <<<"$candidates"
  return 1
}

if ! marketing_base="$(read_marketing_sha)" || ! valid_sha "$marketing_base"; then
  echo "::warning::Cloudflare build revision is unavailable; selecting all validation and release routes."
  write_conservative_outputs true
  exit 0
fi
if ! azure_base="$(read_azure_sha)" || ! valid_sha "$azure_base"; then
  echo "::warning::No successful Azure code-release deployment was found; selecting all validation and release routes."
  write_conservative_outputs true
  exit 0
fi

if ! git -C "$workspace" merge-base --is-ancestor "$marketing_base" "$HEAD_SHA" 2>/dev/null || \
  ! git -C "$workspace" merge-base --is-ancestor "$azure_base" "$HEAD_SHA" 2>/dev/null; then
  echo "::warning::A deployed revision is not an ancestor of current main; selecting all validation and release routes."
  write_conservative_outputs true
  exit 0
fi

# The oldest baseline spans every unshipped product change and controls CI
# suite selection. Each deployment route is classified from its own baseline.
if git -C "$workspace" merge-base --is-ancestor "$marketing_base" "$azure_base" 2>/dev/null; then
  validation_base="$marketing_base"
elif git -C "$workspace" merge-base --is-ancestor "$azure_base" "$marketing_base" 2>/dev/null; then
  validation_base="$azure_base"
else
  echo "::warning::Production baselines have diverged; selecting all validation and release routes."
  write_conservative_outputs true
  exit 0
fi

classify_range() {
  local base="$1" output_file="$2" changed_paths="$temporary_directory/changed-paths"
  if ! git -C "$workspace" diff --no-renames --name-only "$base" "$HEAD_SHA" > "$changed_paths"; then
    return 1
  fi
  GITHUB_OUTPUT="$output_file" bash "$classifier" < "$changed_paths"
}

validation_output="$temporary_directory/validation"
azure_output="$temporary_directory/azure"
marketing_output="$temporary_directory/marketing"
final_output="$temporary_directory/final"
: > "$final_output"
if ! classify_range "$validation_base" "$validation_output" || \
  ! classify_range "$azure_base" "$azure_output" || \
  ! classify_range "$marketing_base" "$marketing_output"; then
  echo "::warning::Could not classify the complete production gap; selecting all validation and release routes."
  write_conservative_outputs true
  exit 0
fi

read_field() {
  local file="$1" field="$2" value
  value="$(awk -F= -v name="$field" '$1 == name { value=$2; count++ } END { if (count != 1) exit 1; print value }' "$file")" || return 1
  [[ "$value" == true || "$value" == false ]] || return 1
  printf '%s\n' "$value"
}

for field in docs-only tooling-only marketing app desktop shared; do
  if ! value="$(read_field "$validation_output" "$field")"; then
    echo "::warning::Classifier output is incomplete; selecting all validation and release routes."
    write_conservative_outputs true
    exit 0
  fi
  printf '%s=%s\n' "$field" "$value" >> "$final_output"
done
if ! value="$(read_field "$marketing_output" marketing-deploy)"; then
  echo "::warning::Marketing route is incomplete; selecting all validation and release routes."
  write_conservative_outputs true
  exit 0
fi
printf 'marketing-deploy=%s\n' "$value" >> "$final_output"
if ! value="$(read_field "$azure_output" azure-deploy)"; then
  echo "::warning::Azure route is incomplete; selecting all validation and release routes."
  write_conservative_outputs true
  exit 0
fi
printf 'azure-deploy=%s\ncurrent-main=true\n' "$value" >> "$final_output"
cat "$final_output" >> "$GITHUB_OUTPUT"
