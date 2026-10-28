#!/usr/bin/env bash
# Path classifier for CI change detection.
#
# Reads file paths from stdin (one per line) and outputs boolean routing flags
# to GITHUB_OUTPUT (or stdout when run outside a workflow):
#   tooling-only — only known CI/deployment tooling and optional docs changed
#   docs-only  — every changed file is a non-executable documentation/agent-rules file
#   marketing  — at least one file is under apps/marketing or apps/marketing-motion
#   app        — at least one file is under apps/web or apps/worker
#   desktop    — at least one file is under apps/desktop
#   shared     — at least one file is in a shared location (packages/, root config, .github/)
#   engine-worker-contract — worker/desktop/shared or unknown paths require the pinned contract gate
#   database-tests — app/shared runtime changes require disposable PostgreSQL/Redis validation
#   database-services — database-tests or a changed live DB/Redis fixture requires local services
#   desktop-frontend-tests — Desktop sources, its fixture/toolchain inputs or unknown paths
#   web-component / worker-component — source consumers, independent of packaging
#   web-image / worker-image / egress-image — optional packaging qualifications
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
docs_pattern='^(\.gitignore|\.gitattributes|LICENSE|renovate\.json|.*\.md|\.devin/|\.claude/|\.codeium/|\.cursor/|\.agents/|\.windsurf/)$'
marketing_pattern='^apps/(marketing|marketing-motion)/'
app_pattern='^apps/(web|worker)/'
desktop_pattern='^apps/desktop/'
shared_pattern='^(docs/marketplace/|packages/|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig\.json|tsconfig\.tsbuildinfo|eslint\.config\.mjs|vitest\.config\.ts|playwright\.config\.ts|docker-compose\.yml|Dockerfile|action\.yml|\.gitleaks\.toml|\.env\.example|ops/|e2e/|lint/serial-comma-baseline\.json|run-all-tests\.mjs|\.github/)'
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
tooling_pattern='^(\.github/workflows/(ci|deploy-azure|deploy-azure-runtime|deploy-marketing|lighthouse-production|release-production)\.yml|\.github/scripts/(classify-paths|classify-main-change-gap)\.sh|\.github/scripts/(assert-named-vitest-tests\.mjs|migration-database-identity\.mjs|deploy-azure-(preflight|rollout)\.sh|promote-worker-vm\.sh|verify-engine-revision\.sh|verify-engine-worker-contract\.sh|validate-worker-provenance\.sh|azure_secret_set\.sh|webhook-claims-maintenance\.sh|webhook-claims-vm\.sh|validate-webhook-deploy-dispatch\.sh|verify-webhook-cutover(-preflight)?\.mjs)|\.github/scripts/tests/.*|ops/deployment/.*|ops/monitoring/.*|lint/serial-comma-baseline\.json|run-all-tests\.mjs)$'
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

desktop_frontend_tests=false
runtime_app=false
web_component=false
worker_component=false
web_image=false
worker_image=false
egress_image=false

# Desktop imports the scan-depth fixture directly; it has no workspace package
# dependency on types. Root JS build/toolchain inputs also affect its frontend.
desktop_frontend_pattern='^(apps/desktop/|packages/types/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|turbo\.json$|tsconfig\.json$|eslint\.config\.mjs$|vitest\.config\.ts$)'
# Only non-executable web presentation inputs can skip live runtime proofs.
# JSX/TSX remains conservative: server components may import DB/auth services.
presentation_pattern='^(apps/web/public/.*\.(png|jpe?g|webp|avif|gif|ico|woff2?|ttf|otf)$|apps/web/.*\.css$)'

# Required host checks own ordinary source, tests and static assets. Optional
# images qualify packaging/build assumptions; release still builds and verifies
# every exact image before promotion. Unknown inputs retain all image targets.
image_packaging_pattern='(^|/)(Dockerfile[^/]*|\.dockerignore|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig[^/]*\.json|[^/]*\.config\.(ts|js|mjs|cjs|json)|\.npmrc|\.pnpmfile\.cjs)$'
image_build_workflow_pattern='^\.github/workflows/(ci|deploy-azure|release-tauri|verify-webhook-worker-image)\.yml$'
source_input_pattern='\.(tsx?|jsx?|mjs|cjs|css|scss|sass|less|json|prisma|sql|astro|mdx|html|svg|png|jpe?g|webp|avif|gif|ico|woff2?|ttf|otf|mp4|webm|mp3|wav|snap|map)$'
worker_host_pattern='^ops/worker/(run-worker\.sh|worker-env\.sh|webhook-cutover-(recovery|schema)\.mjs|refresh-(secrets|egress)\.sh|capture-stop-provenance\.sh|lyrashield-worker(-secrets|-egress|-egress-refresh)?\.(service|timer))$'

while IFS= read -r f || [[ -n "$f" ]]; do
  [ -z "$f" ] && continue
  if [[ "$f" =~ $tooling_pattern ]]; then
    tooling_seen=true
  elif ! [[ "$f" =~ $docs_pattern ]]; then
    tooling_only=false
  fi
  path_classified=false
  if [[ "$f" =~ $docs_pattern ]]; then
    path_classified=true
  else
    docs_only=false
  fi
  if [[ "$f" =~ $marketing_pattern ]]; then
    marketing=true
    path_classified=true
  fi
  if [[ "$f" =~ $app_pattern ]]; then
    app=true
    if ! [[ "$f" =~ $presentation_pattern ]]; then
      runtime_app=true
      engine_worker_contract=true
    fi
    path_classified=true
  fi
  if [[ "$f" =~ $desktop_pattern ]]; then
    desktop=true
    engine_worker_contract=true
    path_classified=true
  fi
  if [[ "$f" =~ $shared_pattern ]]; then
    shared=true
    engine_worker_contract=true
    path_classified=true
  fi
  if [[ "$f" =~ $marketing_deploy_pattern ]]; then
    marketing_deploy=true
  fi
  if [[ "$f" =~ $azure_deploy_pattern ]]; then
    azure_deploy=true
  fi
  if [[ "$f" =~ $marketing_tests_pattern ]]; then marketing_tests=true; fi
  if [[ "$f" =~ $motion_tests_pattern ]]; then motion_tests=true; fi
  if [[ "$f" =~ $ops_tests_pattern ]]; then ops_tests=true; fi
  if [[ "$f" =~ $database_runtime_pattern ]]; then database_runtime_seen=true; fi
  if [[ "$f" =~ $desktop_frontend_pattern ]]; then desktop_frontend_tests=true; fi
  if [[ "$f" == apps/web/* ]]; then web_component=true; fi
  if [[ "$f" == apps/worker/* ]]; then worker_component=true; fi
  if [[ "$f" =~ $worker_host_pattern || "$f" == apps/worker/scripts/* ]]; then
    worker_image=true
  elif [[ "$f" =~ $image_build_workflow_pattern ]]; then
    web_image=true
    worker_image=true
    egress_image=true
  elif [[ "$f" =~ $image_packaging_pattern ]]; then
    if [[ "$f" == apps/web/* && "$f" != */package.json ]]; then web_image=true
    elif [[ "$f" == apps/worker/* && "$f" != */package.json ]]; then worker_image=true
    else
      web_image=true
      worker_image=true
      egress_image=true
    fi
  elif [[ "$f" == apps/web/* || "$f" == apps/worker/* || "$f" == packages/* ]]; then
    if ! [[ "$f" =~ $docs_pattern || "$f" =~ $source_input_pattern ]]; then
      web_image=true
      worker_image=true
      egress_image=true
    fi
  fi
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
  desktop_frontend_tests=true
  web_component=true
  worker_component=true
  web_image=true
  worker_image=true
  egress_image=true
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
  desktop_frontend_tests=true
  runtime_app=true
  web_component=true
  worker_component=true
  web_image=true
  worker_image=true
  egress_image=true
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
if [[ "$runtime_app" == "true" || ( "$shared" == "true" && "$tooling_only" == "false" ) ]]; then
  database_tests=true
fi
database_services="$database_tests"
if [[ "$database_runtime_seen" == "true" ]]; then
  database_services=true
fi

# Emit one complete receipt, using the same format locally and on Actions.
emit_flags() {
  printf '%s\n' \
    "docs-only=$docs_only" \
    "tooling-only=$tooling_only" \
    "marketing=$marketing" \
    "app=$app" \
    "desktop=$desktop" \
    "shared=$shared" \
    "marketing-deploy=$marketing_deploy" \
    "azure-deploy=$azure_deploy" \
    "marketing-tests=$marketing_tests" \
    "motion-tests=$motion_tests" \
    "ops-tests=$ops_tests" \
    "engine-worker-contract=$engine_worker_contract" \
    "database-tests=$database_tests" \
    "database-services=$database_services" \
    "web-component=$web_component" \
    "worker-component=$worker_component" \
    "web-image=$web_image" \
    "worker-image=$worker_image" \
    "egress-image=$egress_image" \
    "desktop-frontend-tests=$desktop_frontend_tests"
}
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  emit_flags >> "$GITHUB_OUTPUT"
else
  emit_flags
fi
