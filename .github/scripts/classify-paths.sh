#!/usr/bin/env bash
# Path classifier for CI change detection.
#
# Reads file paths from stdin (one per line) and outputs seven boolean outputs
# to GITHUB_OUTPUT (or stdout when run outside a workflow):
#   docs-only  — every changed file is a docs/config/agent-rules file
#   marketing  — at least one file is under apps/marketing or apps/marketing-motion
#   app        — at least one file is under apps/web or apps/worker
#   desktop    — at least one file is under apps/desktop
#   shared     — at least one file is in a shared location (packages/, root config, .github/)
#   marketing-deploy — marketing source or a dependency that changes its Worker artifact
#   azure-deploy — app or shared change requiring an Azure production release
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
desktop_pattern='^apps/desktop/'
shared_pattern='^(packages/|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig\.json|tsconfig\.tsbuildinfo|eslint\.config\.mjs|vitest\.config\.ts|playwright\.config\.ts|playwright\.marketing\.config\.ts|docker-compose\.yml|Dockerfile|action\.yml|\.gitleaks\.toml|\.env\.example|ops/|e2e/|run-all-tests\.mjs|\.github/)'
# CI validation is deliberately broader than release routing. Workflow, test,
# Action, and tooling changes must be checked, but do not alter a production
# artifact. Unknown paths remain fail-closed below.
marketing_deploy_pattern='^(apps/(marketing|marketing-motion)/|packages/|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig\.json|tsconfig\.tsbuildinfo)'
azure_deploy_pattern='^(apps/(web|worker)/|packages/|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig\.json|tsconfig\.tsbuildinfo|Dockerfile|docker-compose\.yml|ops/(deployment|worker)/)'

docs_only=true
marketing=false
app=false
desktop=false
shared=false
unknown=false
marketing_deploy=false
azure_deploy=false

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
  if echo "$f" | grep -qE "$desktop_pattern"; then
    desktop=true
  fi
  if echo "$f" | grep -qE "$shared_pattern"; then
    shared=true
  fi
  if echo "$f" | grep -qE "$marketing_deploy_pattern"; then
    marketing_deploy=true
  fi
  if echo "$f" | grep -qE "$azure_deploy_pattern"; then
    azure_deploy=true
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
if [[ "$docs_only" == "false" && "$marketing" == "false" && "$app" == "false" && "$desktop" == "false" && "$shared" == "false" ]]; then
  shared=true
  unknown=true
fi

# Azure owns the app, worker, and shared runtime dependencies. Marketing and
# desktop have their own delivery paths; docs-only changes need no deployment.
# An unknown path is fail-closed because its build impact is not yet classified.
if [[ "$unknown" == "true" ]]; then
  marketing_deploy=true
  azure_deploy=true
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "docs-only=$docs_only" >> "$GITHUB_OUTPUT"
  echo "marketing=$marketing" >> "$GITHUB_OUTPUT"
  echo "app=$app" >> "$GITHUB_OUTPUT"
  echo "desktop=$desktop" >> "$GITHUB_OUTPUT"
  echo "shared=$shared" >> "$GITHUB_OUTPUT"
  echo "marketing-deploy=$marketing_deploy" >> "$GITHUB_OUTPUT"
  echo "azure-deploy=$azure_deploy" >> "$GITHUB_OUTPUT"
else
  echo "docs-only=$docs_only"
  echo "marketing=$marketing"
  echo "app=$app"
  echo "desktop=$desktop"
  echo "shared=$shared"
  echo "marketing-deploy=$marketing_deploy"
  echo "azure-deploy=$azure_deploy"
fi
