#!/usr/bin/env bash
# Test harness for .github/scripts/classify-paths.sh
#
# Exercises the path classifier with known inputs and asserts the four
# boolean outputs. Run with: bash .github/scripts/tests/test-classify-paths.sh
#
# Added by Deep Review v12 (P1-5): the CI-skip classifier was introduced in
# commit add4741 without a reviewable diff or a test. This test prevents
# silent regressions in the gate that decides whether lint/typecheck/test/build
# run on a PR.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLASSIFY="$SCRIPT_DIR/../classify-paths.sh"

# In GitHub Actions, GITHUB_OUTPUT is always set. The classifier writes to
# $GITHUB_OUTPUT when present and to stdout otherwise. The test harness
# captures stdout, so unset it to force stdout output.
unset GITHUB_OUTPUT

pass=0
fail=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $label — expected '$expected', got '$actual'" >&2
  fi
}

run_classify() {
  # Pipe file list into the classifier and capture stdout (no GITHUB_OUTPUT set).
  # printf preserves embedded newlines and adds a trailing newline so the
  # last line is not missed by the classifier's `while read` loop.
  printf '%s\n' "$1" | bash "$CLASSIFY"
}

get_field() {
  # Extract a field from "key=value" output.
  echo "$1" | grep "^$2=" | cut -d= -f2
}

# --- Test 1: docs-only changes skip CI ---
out=$(run_classify $'AGENTS.md\nREADME.md\ndocs/guide.md')
assert_eq "docs-only: all .md files" "true" "$(get_field "$out" "docs-only")"
assert_eq "docs-only: marketing" "false" "$(get_field "$out" "marketing")"
assert_eq "docs-only: app" "false" "$(get_field "$out" "app")"
assert_eq "docs-only: shared" "false" "$(get_field "$out" "shared")"

# --- Test 2: app changes trigger full CI ---
out=$(run_classify $'apps/web/src/app/page.tsx\napps/worker/src/jobs/run-scan.job.ts')
assert_eq "app: docs-only" "false" "$(get_field "$out" "docs-only")"
assert_eq "app: app" "true" "$(get_field "$out" "app")"
assert_eq "app: marketing" "false" "$(get_field "$out" "marketing")"
assert_eq "app: shared" "false" "$(get_field "$out" "shared")"

# --- Test 3: marketing changes trigger marketing deploy ---
out=$(run_classify $'apps/marketing/src/pages/index.astro\napps/marketing-motion/src/scene.ts')
assert_eq "marketing: docs-only" "false" "$(get_field "$out" "docs-only")"
assert_eq "marketing: marketing" "true" "$(get_field "$out" "marketing")"
assert_eq "marketing: app" "false" "$(get_field "$out" "app")"

# --- Test 4: shared package changes trigger full CI ---
out=$(run_classify $'packages/db/src/scan-service.ts\npackages/auth/src/auth.ts')
assert_eq "shared: docs-only" "false" "$(get_field "$out" "docs-only")"
assert_eq "shared: shared" "true" "$(get_field "$out" "shared")"
assert_eq "shared: app" "false" "$(get_field "$out" "app")"

# --- Test 5: mixed docs + app → NOT docs-only ---
out=$(run_classify $'AGENTS.md\napps/web/src/app/page.tsx')
assert_eq "mixed: docs-only" "false" "$(get_field "$out" "docs-only")"
assert_eq "mixed: app" "true" "$(get_field "$out" "app")"

# --- Test 6: .github/ workflow change is shared ---
out=$(run_classify $'.github/workflows/ci.yml')
assert_eq "github: docs-only" "false" "$(get_field "$out" "docs-only")"
assert_eq "github: shared" "true" "$(get_field "$out" "shared")"

# --- Test 7: an uncovered path falls back to shared (fail-closed, v13 P1-7) ---
# ops/, e2e/, root tooling, and new root configs must not silently skip deploys.
out=$(run_classify $'ops/worker/refresh-egress.sh')
assert_eq "ops: docs-only" "false" "$(get_field "$out" "docs-only")"
assert_eq "ops: marketing" "false" "$(get_field "$out" "marketing")"
assert_eq "ops: app" "false" "$(get_field "$out" "app")"
assert_eq "ops: shared (fallback)" "true" "$(get_field "$out" "shared")"

out=$(run_classify $'e2e/visual/home.spec.ts')
assert_eq "e2e: shared (fallback)" "true" "$(get_field "$out" "shared")"

out=$(run_classify $'run-all-tests.mjs')
assert_eq "run-all-tests: shared (fallback)" "true" "$(get_field "$out" "shared")"

# --- Test 8: ops/ is also matched directly by shared_pattern now ---
out=$(run_classify $'ops/worker/refresh-egress.sh\napps/web/src/app/page.tsx')
assert_eq "ops+app: app" "true" "$(get_field "$out" "app")"
assert_eq "ops+app: shared" "true" "$(get_field "$out" "shared")"

# --- Test 7: agent config dirs are docs-only ---
out=$(run_classify $'.devin/rules/AGENTS.md\n.claude/skills/foo/SKILL.md')
assert_eq "agent-config: docs-only" "true" "$(get_field "$out" "docs-only")"

# --- Test 8: root config files are docs-only ---
out=$(run_classify $'.nvmrc\nLICENSE\n.gitignore')
assert_eq "root-config: docs-only" "true" "$(get_field "$out" "docs-only")"

# --- Test 9: empty input → docs-only=true (vacuous truth, matches workflow) ---
out=$(run_classify "")
assert_eq "empty: docs-only" "true" "$(get_field "$out" "docs-only")"

# --- Test 10: docker-compose.yml is shared (affects full stack) ---
out=$(run_classify $'docker-compose.yml')
assert_eq "docker: docs-only" "false" "$(get_field "$out" "docs-only")"
assert_eq "docker: shared" "true" "$(get_field "$out" "shared")"

# --- Test 11: Dockerfile is shared ---
out=$(run_classify $'Dockerfile')
assert_eq "dockerfile: docs-only" "false" "$(get_field "$out" "docs-only")"
assert_eq "dockerfile: shared" "true" "$(get_field "$out" "shared")"

# --- Test 12: app + marketing + shared in one push ---
out=$(run_classify $'apps/web/src/app/page.tsx\napps/marketing/src/pages/index.astro\npackages/ui/src/button.tsx')
assert_eq "multi: docs-only" "false" "$(get_field "$out" "docs-only")"
assert_eq "multi: app" "true" "$(get_field "$out" "app")"
assert_eq "multi: marketing" "true" "$(get_field "$out" "marketing")"
assert_eq "multi: shared" "true" "$(get_field "$out" "shared")"

# --- Test 13: desktop changes trigger desktop CI ---
out=$(run_classify $'apps/desktop/src-tauri/src/license/mod.rs\napps/desktop/frontend/src/App.tsx')
assert_eq "desktop: docs-only" "false" "$(get_field "$out" "docs-only")"
assert_eq "desktop: desktop" "true" "$(get_field "$out" "desktop")"
assert_eq "desktop: app" "false" "$(get_field "$out" "app")"
assert_eq "desktop: shared" "false" "$(get_field "$out" "shared")"

echo "Results: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  exit 1
fi
