#!/usr/bin/env bash
# Path classifier for CI change detection.
#
# Reads file paths from stdin (one per line) and outputs boolean routing flags
# to GITHUB_OUTPUT (or stdout when run outside a workflow):
#   tooling-only — only known CI/deployment tooling and optional docs changed
#   docs-only  — every changed file is a docs/config/agent-rules file
#   marketing  — at least one file is under apps/marketing or apps/marketing-motion
#   app        — at least one file is under apps/web or apps/worker
#   desktop    — at least one file is under apps/desktop
#   shared     — at least one file is in a shared location (packages/, root config, .github/)
#   engine-worker-contract — worker/desktop/shared or unknown paths require the pinned contract gate
#   database-tests — app/shared runtime changes require disposable PostgreSQL/Redis validation
#   database-services — database-tests or a changed live DB/Redis fixture requires local services
#   marketing-deploy — marketing source or a dependency that changes its Worker artifact
#   azure-deploy — app or shared change requiring an Azure production release
#
# Extracted from .github/workflows/ci.yml by Deep Review v12 (P1-5) so the
# classifier logic is testable independently of the workflow runtime.
set -euo pipefail

force_all=false
if [[ "${1:-}" == "--force-all" ]]; then
  force_all=true
elif [[ "$#" -ne 0 ]]; then
  echo "Usage: classify-paths.sh [--force-all]" >&2
  exit 2
fi

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
shared_pattern='^(packages/|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig\.json|tsconfig\.tsbuildinfo|eslint\.config\.mjs|vitest\.config\.ts|playwright\.config\.ts|docker-compose\.yml|Dockerfile|action\.yml|\.gitleaks\.toml|\.env\.example|ops/|e2e/|run-all-tests\.mjs|\.github/)'
# CI validation is deliberately broader than release routing. Workflow, test,
# Action, and tooling changes must be checked, but do not alter a production
# artifact. Unknown paths remain fail-closed below.
marketing_deploy_pattern='^(\.github/workflows/deploy-marketing\.yml|apps/(marketing|marketing-motion)/|packages/|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig\.json|tsconfig\.tsbuildinfo)'
# Keep independent marketing projects and their browser tests out of unrelated
# deployment-tool changes. Shared build/dependency inputs still select both.
marketing_tests_pattern='^(apps/marketing/|packages/(agent-registry|agent-rules|auth|billing|config|db|egress-proxy|evidence-storage|gate|integrations|licenses|logger|myra|pricing|score|security|types)/|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig\.json|tsconfig\.tsbuildinfo|eslint\.config\.mjs|vitest\.config\.ts|playwright\.config\.ts)'
motion_tests_pattern='^(apps/marketing-motion/|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig\.json|tsconfig\.tsbuildinfo|eslint\.config\.mjs)'
# Ops tests read workflow/helper sources, actual DB fixtures and package
# manifests. Keep shared packages conservative; ordinary app UI/routes do not
# enter these tests. Unknown paths and force-all select every suite below.
ops_tests_pattern='^(\.github/|ops/|packages/|apps/(web|worker|marketing|marketing-motion)/package\.json|run-all-tests\.mjs|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig\.json|tsconfig\.tsbuildinfo|eslint\.config\.mjs|vitest\.config\.ts|playwright\.config\.ts|Dockerfile|docker-compose\.yml|action\.yml|\.gitleaks\.toml|\.env\.example)'
azure_deploy_pattern='^(apps/(web|worker)/|packages/|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig\.json|tsconfig\.tsbuildinfo|Dockerfile|docker-compose\.yml|ops/(deployment|worker)/|\.github/scripts/(promote-worker-vm|verify-engine-revision|verify-engine-worker-contract|deploy-azure-preflight|deploy-azure-rollout|webhook-claims-maintenance|webhook-claims-vm|validate-webhook-deploy-dispatch|azure_secret_set|validate-worker-provenance)\.sh|\.github/scripts/(migration-database-identity|verify-webhook-cutover(-preflight)?)\.mjs|\.github/workflows/(deploy-azure|deploy-azure-runtime|release-production)\.yml)'

# Only explicitly covered tooling can skip runtime suites. Unknown and mixed
# changes keep the existing broad classification and deployment decision.
tooling_pattern='^(\.github/workflows/(ci|deploy-azure|deploy-azure-runtime|deploy-marketing|lighthouse-production|release-production)\.yml|\.github/scripts/(classify-paths|classify-main-change-gap)\.sh|\.github/scripts/(assert-named-vitest-tests\.mjs|migration-database-identity\.mjs|deploy-azure-(preflight|rollout)\.sh|promote-worker-vm\.sh|verify-engine-revision\.sh|verify-engine-worker-contract\.sh|validate-worker-provenance\.sh|azure_secret_set\.sh|webhook-claims-maintenance\.sh|webhook-claims-vm\.sh|validate-webhook-deploy-dispatch\.sh|verify-webhook-cutover(-preflight)?\.mjs)|\.github/scripts/tests/.*|ops/deployment/.*|ops/monitoring/.*|run-all-tests\.mjs)$'
database_runtime_pattern='^(\.github/scripts/verify-webhook-cutover\.mjs|\.github/scripts/webhook-claims-vm\.sh|\.github/scripts/tests/webhook-(catalog|queue)\.runtime\.test\.mjs)$'
tooling_only=true
tooling_seen=false

docs_only=true
marketing=false
app=false
desktop=false
shared=false
unknown=false
marketing_deploy=false
azure_deploy=false
marketing_tests=false
motion_tests=false
ops_tests=false
engine_worker_contract=false
database_tests=false
database_runtime_seen=false

while IFS= read -r f; do
  [ -z "$f" ] && continue
  if echo "$f" | grep -qE "$tooling_pattern"; then
    tooling_seen=true
  elif ! echo "$f" | grep -qE "$docs_pattern"; then
    tooling_only=false
  fi
  path_classified=false
  if echo "$f" | grep -qE "$docs_pattern"; then
    path_classified=true
  else
    docs_only=false
  fi
  if echo "$f" | grep -qE "$marketing_pattern"; then
    marketing=true
    path_classified=true
  fi
  if echo "$f" | grep -qE "$app_pattern"; then
    app=true
    engine_worker_contract=true
    path_classified=true
  fi
  if echo "$f" | grep -qE "$desktop_pattern"; then
    desktop=true
    engine_worker_contract=true
    path_classified=true
  fi
  if echo "$f" | grep -qE "$shared_pattern"; then
    shared=true
    engine_worker_contract=true
    path_classified=true
  fi
  if echo "$f" | grep -qE "$marketing_deploy_pattern"; then
    marketing_deploy=true
  fi
  if echo "$f" | grep -qE "$azure_deploy_pattern"; then
    azure_deploy=true
  fi
  if echo "$f" | grep -qE "$marketing_tests_pattern"; then marketing_tests=true; fi
  if echo "$f" | grep -qE "$motion_tests_pattern"; then motion_tests=true; fi
  if echo "$f" | grep -qE "$ops_tests_pattern"; then ops_tests=true; fi
  if echo "$f" | grep -qE "$database_runtime_pattern"; then database_runtime_seen=true; fi
  if [[ "$path_classified" == "false" ]]; then
    shared=true
    unknown=true
  fi
done

if $marketing || $app || $desktop || $shared; then docs_only=false; fi
if ! $tooling_seen || $marketing || $app || $desktop || $unknown; then tooling_only=false; fi

# Fail closed per path: an uncovered file mixed with recognized files must not
# inherit their narrower deployment routing. Treat it as shared and deploy both
# artifacts until it receives an explicit category.

# Azure owns the app, worker, and shared runtime dependencies. Marketing and
# desktop have their own delivery paths; docs-only changes need no deployment.
# An unknown path is fail-closed because its build impact is not yet classified.
if [[ "$unknown" == "true" ]]; then
  marketing_deploy=true
  azure_deploy=true
  marketing_tests=true
  motion_tests=true
  ops_tests=true
  engine_worker_contract=true
fi

# A missing or untrusted production baseline must run every path-selected gate
# and route both artifacts. Callers use this mode when they cannot prove what
# is currently deployed; it is intentionally broader than an unknown path.
if $force_all; then
  docs_only=false
  tooling_only=false
  marketing=true
  app=true
  desktop=true
  shared=true
  marketing_deploy=true
  azure_deploy=true
  marketing_tests=true
  motion_tests=true
  ops_tests=true
  engine_worker_contract=true
fi

# Full database suites follow app/shared runtime changes. Only the webhook
# verifier and queue-helper sources keep narrowly scoped live fixtures when
# changed as tooling. Unknown paths fall back to shared and stay fail-closed.
if [[ "$app" == "true" || ( "$shared" == "true" && "$tooling_only" == "false" ) ]]; then
  database_tests=true
fi
database_services="$database_tests"
if [[ "$database_runtime_seen" == "true" ]]; then
  database_services=true
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "docs-only=$docs_only"
    echo "tooling-only=$tooling_only"
    echo "marketing=$marketing"
    echo "app=$app"
    echo "desktop=$desktop"
    echo "shared=$shared"
    echo "marketing-deploy=$marketing_deploy"
    echo "azure-deploy=$azure_deploy"
    echo "marketing-tests=$marketing_tests"
    echo "motion-tests=$motion_tests"
    echo "ops-tests=$ops_tests"
    echo "engine-worker-contract=$engine_worker_contract"
    echo "database-tests=$database_tests"
    echo "database-services=$database_services"
  } >> "$GITHUB_OUTPUT"
else
  echo "docs-only=$docs_only"
  echo "tooling-only=$tooling_only"
  echo "marketing=$marketing"
  echo "app=$app"
  echo "desktop=$desktop"
  echo "shared=$shared"
  echo "marketing-deploy=$marketing_deploy"
  echo "azure-deploy=$azure_deploy"
  echo "marketing-tests=$marketing_tests"
  echo "motion-tests=$motion_tests"
  echo "ops-tests=$ops_tests"
  echo "engine-worker-contract=$engine_worker_contract"
  echo "database-tests=$database_tests"
  echo "database-services=$database_services"
fi
