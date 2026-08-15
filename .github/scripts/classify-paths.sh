#!/usr/bin/env bash
# Path classifier for CI change detection.
#
# Reads file paths from stdin (one per line) and outputs four boolean outputs
# to GITHUB_OUTPUT (or stdout when run outside a workflow):
#   docs-only  — every changed file is a docs/config/agent-rules file
#   marketing  — at least one file is under apps/marketing or apps/marketing-motion
#   app        — at least one file is under apps/web or apps/worker
#   shared     — at least one file is in a shared location (packages/, root config, .github/)
#
# Extracted from .github/workflows/ci.yml by Deep Review v12 (P1-5) so the
# classifier logic is testable independently of the workflow runtime.
set -euo pipefail

# Path classification patterns.
# docs_pattern: files that never affect build, lint, typecheck, or tests.
#   NOTE: .devin/, .claude/, .codeium/, .cursor/, .agents/, .windsurf/ are
#   agent/tool config directories — they are NOT code and do not enter the
#   build. If executable scripts are later added under these dirs that DO
#   affect the product, narrow this pattern rather than broadening it.
docs_pattern='^(\.gitignore|\.prettierignore|\.prettierrc\.json|\.editorconfig|\.gitattributes|\.nvmrc|\.python-version|LICENSE|renovate\.json|.*\.md|\.devin/|\.claude/|\.codeium/|\.cursor/|\.agents/|\.windsurf/)$'
marketing_pattern='^apps/(marketing|marketing-motion)/'
app_pattern='^apps/(web|worker)/'
shared_pattern='^(packages/|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig\.json|tsconfig\.tsbuildinfo|eslint\.config\.mjs|vitest\.config\.ts|playwright\.config\.ts|playwright\.marketing\.config\.ts|docker-compose\.yml|Dockerfile|action\.yml|\.gitleaks\.toml|\.env\.example|ops/|e2e/|run-all-tests\.mjs|\.github/)'

docs_only=true
marketing=false
app=false
shared=false

while IFS= read -r f; do
  [ -z "$f" ] && continue
  if ! echo "$f" | grep -qE "$docs_pattern"; then
    docs_only=false
  fi
  if echo "$f" | grep -qE "$marketing_pattern"; then
    marketing=true
  fi
  if echo "$f" | grep -qE "$app_pattern"; then
    app=true
  fi
  if echo "$f" | grep -qE "$shared_pattern"; then
    shared=true
  fi
done

# Fail-closed fallback: if a change matched none of the four buckets, treat it
# as shared so CI still runs. Without this, an uncovered path (e.g. a new root
# config file, an ops/ script, an e2E/ fixture, or run-all-tests.mjs itself)
# classifies as all-false — which preserves the main lint/typecheck/test/build
# job (it gates on docs-only != 'true') but silently skips BOTH deploy jobs and
# the engine-worker-contract gate (they need marketing|shared or app|shared).
# Routing unknowns to shared is the safe direction: it over-runs CI rather than
# under-deploying. (Deep Review v13, P1-7.)
if [[ "$docs_only" == "false" && "$marketing" == "false" && "$app" == "false" && "$shared" == "false" ]]; then
  shared=true
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "docs-only=$docs_only" >> "$GITHUB_OUTPUT"
  echo "marketing=$marketing" >> "$GITHUB_OUTPUT"
  echo "app=$app" >> "$GITHUB_OUTPUT"
  echo "shared=$shared" >> "$GITHUB_OUTPUT"
else
  echo "docs-only=$docs_only"
  echo "marketing=$marketing"
  echo "app=$app"
  echo "shared=$shared"
fi
