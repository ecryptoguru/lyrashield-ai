#!/usr/bin/env bash
# Static contract tests for the required CI gate's conditional DB services.
set -euo pipefail

WORKFLOW="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/workflows/ci.yml"
WORKFLOW_CONTENT="$(cat "$WORKFLOW")"
JOB="$(sed -n '/^  lint-and-typecheck:/,/^  engine-worker-contract:/p' "$WORKFLOW")"
failures=0

assert_contains() {
  local label="$1" expected="$2"
  if [[ "$JOB" != *"$expected"* ]]; then
    echo "FAIL: $label — missing '$expected'" >&2
    failures=$((failures + 1))
  fi
}

assert_not_contains() {
  local label="$1" unexpected="$2"
  if [[ "$JOB" == *"$unexpected"* ]]; then
    echo "FAIL: $label — found '$unexpected'" >&2
    failures=$((failures + 1))
  fi
}

step_condition() {
  local name="$1"
  awk -v name="      - name: $name" '
    $0 == name { found = 1; next }
    found && /^      - name:/ { exit }
    found && /^        if:/ { sub(/^        if: /, ""); print; exit }
  ' <<< "$JOB"
}

assert_step_gated() {
  local name="$1"
  local flag="${2:-database-tests}"
  local actual
  actual="$(step_condition "$name")"
  if [[ "$actual" != "needs.changes.outputs.$flag == 'true'" ]]; then
    echo "FAIL: $name — expected $flag gate, got '${actual:-no condition}'" >&2
    failures=$((failures + 1))
  fi
}

# The existing required context remains the single aggregate. Failure of path
# classification and cancellation before or during checks fail this job.
assert_contains "required context name" "name: Lint, Typecheck, Test & Build"
if [[ "$WORKFLOW_CONTENT" != *"database-tests: \${{ steps.classify.outputs.database-tests }}"* ]]; then
  echo "FAIL: changes output map omits database-tests" >&2
  failures=$((failures + 1))
fi
if [[ "$WORKFLOW_CONTENT" != *"database-services: \${{ steps.classify.outputs.database-services }}"* ]]; then
  echo "FAIL: changes output map omits database-services" >&2
  failures=$((failures + 1))
fi
assert_contains "job survives dependency failure or cancellation" "if: \${{ always() }}"
assert_contains "pending cancellation check" "if: \${{ cancelled() }}"
assert_contains "pending cancellation fails closed" "Workflow was cancelled before the required CI aggregate could run."
assert_contains "late cancellation fails closed" "Workflow was cancelled while required CI checks were running."
if [[ "$(step_condition "Fail closed when the workflow was cancelled before this gate started")" != '${{ cancelled() }}' ]]; then
  echo "FAIL: pending cancellation guard is missing or has the wrong condition" >&2
  failures=$((failures + 1))
fi
if [[ "$(step_condition "Fail closed when cancelled during required CI checks")" != '${{ cancelled() }}' ]]; then
  echo "FAIL: late cancellation guard is missing or has the wrong condition" >&2
  failures=$((failures + 1))
fi
cleanup_line="$(awk '/^      - name: Remove disposable database containers$/ { print NR; exit }' <<< "$JOB")"
late_guard_line="$(awk '/^      - name: Fail closed when cancelled during required CI checks$/ { print NR; exit }' <<< "$JOB")"
if [[ -z "$cleanup_line" || -z "$late_guard_line" || "$cleanup_line" -ge "$late_guard_line" ]]; then
  echo "FAIL: late cancellation guard must run after disposable-service cleanup" >&2
  failures=$((failures + 1))
fi
last_step_name="$(awk '/^      - name:/ { sub(/^      - name: /, ""); last = $0 } END { print last }' <<< "$JOB")"
if [[ "$last_step_name" != "Fail closed when cancelled during required CI checks" ]]; then
  echo "FAIL: late cancellation guard must remain the final aggregate step" >&2
  failures=$((failures + 1))
fi
assert_not_contains "job does not skip green on cancellation" "if: \${{ always() && !cancelled() }}"
assert_contains "untrusted classifier fails closed" 'if [[ "$CHANGES_RESULT" != success ]]'
assert_contains "missing or invalid flags fail closed" 'if [[ "$flag" != true && "$flag" != false ]]; then'
assert_contains "service startup is path-gated" "if: needs.changes.outputs.database-services == 'true'"
assert_contains "service cleanup runs after failure/cancellation" "if: \${{ always() }}"
assert_contains "core suite uses DB flag" 'if [ "$DATABASE_TESTS" = true ]; then'
assert_contains "disposable marker follows service flag" "LYRASHIELD_TEST_DB_DISPOSABLE: \${{ needs.changes.outputs.database-services == 'true'"
assert_not_contains "services are not eager job services" "    services:"
assert_not_contains "services do not use GitHub service IDs" "job.services.postgres.id"

for step in \
  "Create shadow database" \
  "Migration drift check" \
  "Run database migrations" \
  "Create isolated product regression databases" \
  "Assert policy budgets are nonnegative" \
  "Use a restricted RLS runtime role" \
  "Grant restricted runtime access to regression databases" \
  "Smoke-test production-equivalent account and workspace grants" \
  "Prove metering and queue invariants with disposable services" \
  "Trial integration tests (restricted runtime role)" \
  "Agent operation workspace foreign key test" \
  "Run required PostgreSQL regression tests" \
  "Browser E2E (includes functional mobile shell at 390px)" \
  "Portable browser harness"; do
  assert_step_gated "$step"
done

assert_step_gated "Start disposable PostgreSQL and Redis" database-services
assert_step_gated "Generate Prisma Client" database-services
assert_step_gated "Test webhook catalog Prisma compatibility" database-services

if (( failures > 0 )); then
  echo "CI database gating: $failures failure(s)" >&2
  exit 1
fi

echo "CI database gating: passed"
