#!/usr/bin/env bash
# Static contract literals intentionally retain shell and GitHub expressions.
# shellcheck disable=SC2016
set -euo pipefail

workflow="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/workflows/deploy-billing-staging.yml"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
migration_script="$repo/packages/db/scripts/run-billing-staging-migrations.sh"
recovery_script="$repo/packages/db/scripts/recover-billing-staging-migration.mjs"
role_script="$repo/packages/db/scripts/provision-billing-staging-roles.mjs"
e2e_role_script="$repo/packages/db/scripts/manage-billing-staging-e2e-role.mjs"
job_creator="$repo/.github/scripts/create-billing-staging-job.sh"
job_starter="$repo/.github/scripts/start-billing-staging-job.sh"
e2e_runner="$repo/e2e/billing/run-staging-proof.sh"
e2e_config_smoke="$repo/e2e/billing/verify-staging-config.sh"
e2e_razorpay="$repo/e2e/billing/razorpay-upi-cap-fallback.spec.ts"
geo_router="$repo/packages/billing/src/geo.ts"
playwright_config="$repo/playwright.config.ts"
production_workflow="$repo/.github/workflows/deploy-azure.yml"
proxy="$repo/apps/web/src/proxy.ts"
access_route="$repo/apps/web/src/app/api/staging/access/route.ts"
e2e_fixture="$repo/e2e/billing/fixtures.ts"

must_contain() {
  grep -Fq -- "$1" "$workflow" || {
    echo "FAIL: missing $1" >&2
    exit 1
  }
}

must_not_contain() {
  if grep -Fq -- "$1" "$workflow"; then
    echo "FAIL: forbidden $1" >&2
    exit 1
  fi
}

must_contain "environment:"
must_contain "name: billing-staging"
must_contain "recover_stale_migration:"
must_contain "20260814020000_ai_system_profile_versions"
must_contain "RECOVER_STALE_MIGRATION: \${{ inputs.recover_stale_migration || 'none' }}"
must_contain "if: github.ref == 'refs/heads/main'"
must_contain "id-token: write"
must_contain 'POLAR_BILLING_ADMISSION=off'
must_contain 'RAZORPAY_BILLING_ADMISSION=off'
must_contain 'POLAR_LOCAL_BILLING_ADMISSION=off'
must_contain 'RAZORPAY_LOCAL_BILLING_ADMISSION=off'
must_contain 'LYRASHIELD_DEPLOYMENT_ENVIRONMENT=billing-staging'
must_contain 'BILLING_STAGING_ADMISSION=restricted'
must_contain 'BILLING_STAGING_ACCESS_TOKEN=secretref:billing-staging-access'
must_contain 'RATE_LIMIT_AUTH_MAX=1000'
must_contain 'BILLING_STAGING_REGION=${BILLING_STAGING_REGION}'
must_contain '[ "$REDIS_HOST" = "lyrashield-billing-redis" ]'
must_contain 'Ensure isolated staging Redis TCP ingress'
must_contain '--type internal --transport tcp --target-port 6379 --exposed-port 6379'
must_contain 'ingress.external !== false'
must_contain 'ingress.targetPort !== 6379'
must_contain 'ingress.exposedPort !== 6379'
must_contain 'DATABASE_SERVER: ${{ vars.STAGING_DATABASE_SERVER }}'
must_contain '[ "$DATABASE_SERVER" = "lyrashield-billing-stage-pg" ]'
must_contain 'az postgres flexible-server show'
must_contain 'Microsoft.DBforPostgreSQL/flexibleServers/${DATABASE_SERVER}'
must_contain 'Allow required staging database extensions'
must_contain '--name azure.extensions'
must_contain '--value "${current:+${current},}pgcrypto"'
must_contain 'pgcrypto is not allow-listed on isolated billing staging.'
must_contain 'actual_database_host'
must_contain 'pull_principal_id=$(az identity show'
must_contain '--assignee-object-id "$pull_principal_id"'
must_contain "roleDefinitionName=='AcrPull'"
must_contain '[ "${acrpull_scope,,}" = "${registry_id,,}" ]'
must_contain 'Pull identity must have exactly one AcrPull assignment at the isolated staging registry scope.'
must_contain 'lyrashield-web@${WEB_DIGEST}'
must_contain 'lyrashield-migrate@${MIGRATION_DIGEST}'
must_contain 'lyrashield-billing-e2e@${E2E_DIGEST}'
must_contain "app_runtime_staging"
must_contain "app_system_staging"
must_contain "access-restriction list"
must_contain "application-level staging gate"
must_contain 'target_revision=$(az containerapp show'
must_contain '--revision "$target_revision"'
must_contain "properties.provisioningState, properties.healthState, to_string(properties.trafficWeight), properties.template.containers[0].image"
must_contain 'Billing staging revision ${target_revision} did not become healthy at 100% traffic.'
must_contain 'access_status=$(curl --silent --show-error --output /dev/null --dump-header "$access_headers"'
must_contain '--form-string "token=${STAGING_ACCESS_TOKEN}"'
must_contain 'Restricted staging access handshake failed with HTTP ${access_status}.'
must_contain 'set-cookie: __Host-lyrashield-billing-staging='
must_contain 'grep -Fqi '\''httponly'\'' "$access_headers"'
must_contain 'grep -Fqi '\''secure'\'' "$access_headers"'
must_contain "Checkout exact main revision"
must_contain 'ref: ${{ github.sha }}'
must_contain "Build and push exact-SHA staging web image"
must_contain "Build and push exact-SHA staging migration image"
must_contain "Build and push exact-SHA staging E2E image"
must_contain "target: runner"
must_contain "target: workspace-builder"
must_contain "target: billing-e2e"
must_contain 'org.opencontainers.image.revision=${{ env.IMAGE_SHA }}'
must_contain 'WEB_DIGEST: ${{ steps.build-web.outputs.digest }}'
must_contain 'MIGRATION_DIGEST: ${{ steps.build-migration.outputs.digest }}'
must_contain 'E2E_DIGEST: ${{ steps.build-e2e.outputs.digest }}'
must_contain "Verify staging image provenance and owned job executables"
must_contain '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
must_contain "Delete one-shot database jobs"
must_contain "az containerapp job delete"
must_contain ".github/scripts/create-billing-staging-job.sh"
must_contain "lyrashield-stage-migrate"
must_contain "lyra-stage-migration-recovery"
must_contain "lyrashield-stage-db-role"
must_contain "/app/packages/db/scripts/run-billing-staging-migrations.sh"
must_contain "/app/packages/db/scripts/recover-billing-staging-migration.mjs"
must_contain "/app/packages/db/scripts/provision-billing-staging-roles.mjs"
must_contain "/app/packages/db/scripts/manage-billing-staging-e2e-role.mjs"
must_contain "/app/e2e/billing/run-staging-proof.sh"
must_contain "/app/e2e/billing/verify-staging-config.sh"
must_contain 'BILLING_E2E_DATABASE_URL=secretref:e2e-database-url'
must_contain 'url.searchParams.set("sslmode", "verify-full")'
must_contain 'E2E_ROLE_ACTION=drop'
must_contain 'Recover and remove disposable E2E database access'
must_contain "if: \${{ always() && steps.azure-login.outcome == 'success' }}"
must_contain 'lyrashield-stage-e2e-cleanup'
must_not_contain 'az containerapp job secret remove'
must_contain 'az containerapp job stop'
must_contain 'Timed out stopping active executions'
must_contain 'Timed out applying the secret-bearing template for ${job}'
must_contain 'TRUSTED_PROXY_IP_HEADER=x-forwarded-for'
must_contain 'LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=0'
must_contain 'PLATFORM_ADMIN_EMAILS=${PLATFORM_ADMIN_EMAILS}'
must_contain "DATABASE_SYSTEM_URL=secretref:database-system-url"
must_contain 'database-system-url=${system_database_url}'
must_contain 'DATABASE_ADMIN_URL: ${{ secrets.DATABASE_ADMIN_URL }}'
must_contain 'SYSTEM_PASSWORD: ${{ secrets.STAGING_DATABASE_SYSTEM_PASSWORD }}'
must_not_contain "azure-production"
must_not_contain "app_runtime_prod"
must_not_contain "ghcr.io"
must_not_contain '${{ secrets.DATABASE_SYSTEM_URL }}'
must_not_contain 'STAGING_WEB_DIGEST'
must_not_contain 'STAGING_MIGRATION_DIGEST'
must_not_contain 'STAGING_IMAGE_SHA'
must_not_contain "--args"

# Azure Container App Job names must be lower-case, use only hyphens, and be
# shorter than 32 characters. Keep every ephemeral staging job deployable.
for job in \
  lyra-mig-recover-1234567890 \
  lyra-migrate-1234567890 \
  lyra-db-role-1234567890 \
  lyra-e2e-role-1234567890 \
  lyra-bill-proof-1234567890 \
  lyra-e2e-pre-1234567890 \
  lyra-e2e-post-1234567890 \
  lyra-e2e-warm-1234567890 \
  lyra-stage-migration-recovery \
  lyrashield-stage-migrate \
  lyrashield-stage-db-role \
  lyrashield-stage-e2e-role \
  lyrashield-stage-billing-proof \
  lyrashield-stage-e2e-cleanup; do
  [[ "$job" =~ ^[a-z][a-z0-9-]*[a-z0-9]$ ]] || {
    echo "FAIL: invalid Container App Job name $job" >&2
    exit 1
  }
  [ "${#job}" -lt 32 ] || {
    echo "FAIL: Container App Job name is too long: $job" >&2
    exit 1
  }
done
if [ "$(grep -Fc 'job_suffix=${GITHUB_RUN_ID: -10}' "$workflow")" -ne 4 ]; then
  echo "FAIL: every one-shot job step must derive the same run-scoped suffix" >&2
  exit 1
fi
must_contain 'recovery_job="lyra-e2e-pre-${job_suffix}"'
must_contain 'recovery_job="lyra-e2e-post-${job_suffix}"'
must_not_contain "--command /bin/sh"
must_not_contain "az containerapp job create"
must_not_contain "az containerapp job secret set"
must_not_contain "ROLE_SCRIPT="
must_not_contain "DATABASE_SYSTEM_URL=secretref:database-admin-url"
must_not_contain "POLAR_BILLING_ADMISSION=public"
must_not_contain "RAZORPAY_BILLING_ADMISSION=public"
must_not_contain '!cancelled()'
must_not_contain '{{ index .Config.Labels \"org.opencontainers.image.revision\" }}'
must_contain 'LAST_JOB_EXECUTION="$execution"'
must_contain 'JOB_REPLICA_RETRY_LIMIT=1'
must_contain '"$warm_job" "$e2e_image" /bin/true 300'
must_contain '/app/e2e/billing/run-staging-proof.sh 1800'
must_contain 'Successful billing proof logs did not contain a Playwright pass count.'
must_contain '### Billing staging proof passed'
must_contain 'E2E digest:'
must_contain 'Region/provider:'
must_contain 'Playwright result:'

wait_helper_lines=$(grep -n '^          wait_for_job() {$' "$workflow" | cut -d: -f1)
if [ "$(wc -l <<< "$wait_helper_lines" | tr -d ' ')" -ne 3 ]; then
  echo "FAIL: expected exactly three wait_for_job helpers" >&2
  exit 1
fi
wait_helper_index=0
while IFS= read -r wait_helper_start; do
  wait_helper_index=$((wait_helper_index + 1))
  wait_helper_end=$(awk -v start="$wait_helper_start" 'NR > start && /^          }$/ { print NR; exit }' "$workflow")
  wait_helper_block=$(sed -n "${wait_helper_start},${wait_helper_end}p" "$workflow")
  for diagnostic in \
    'local job=$1 execution status container_name' \
    'az containerapp job secret list' \
    "--query 'properties.template.containers[].env[].secretRef'" \
    'for expected_setting in "$@"' \
    "printf -v expected_secret '%s-%s' \"\$expected_setting\" \"\$job\"" \
    'configured_secrets" == *" ${expected_secret} "*' \
    'template_secret_refs" == *" ${expected_secret} "*' \
    "--query \"properties.template.containers[0].env[?name=='\${expected_name}'].value | [0]\"" \
    "--query 'properties.template.containers[0].name'" \
    'if ! status=$(az containerapp job execution show' \
    '--query properties.status --output tsv 2>/dev/null); then' \
    'Azure can accept a job start before its execution is queryable.' \
    "--query '{name:name,status:properties.status,startTime:properties.startTime,endTime:properties.endTime}'" \
    '--output jsonc || true' \
    'az containerapp job replica list' \
    '--execution "$execution"' \
    'az containerapp job logs show' \
    '--container "$container_name"' \
    '--tail 300' \
    '--format text || true'; do
    if ! grep -Fq -- "$diagnostic" <<< "$wait_helper_block"; then
      echo "FAIL: wait_for_job helper ${wait_helper_index} is missing ${diagnostic}" >&2
      exit 1
    fi
  done
done <<< "$wait_helper_lines"

test -x "$migration_script"
test -x "$recovery_script"
test -x "$role_script"
test -x "$e2e_role_script"
test -x "$job_creator"
test -x "$job_starter"
test -x "$e2e_runner"
test -x "$e2e_config_smoke"
grep -Fq '/app/e2e/billing/verify-staging-config.sh' "$e2e_runner"
grep -Fq 'await import("../../packages/config/src/index.ts")' "$e2e_config_smoke"
grep -Fq 'pnpm --filter @lyrashield/db exec prisma migrate deploy 2>&1' "$migration_script"
grep -Fq 'BILLING_STAGING_RECOVER_MIGRATION' "$recovery_script"
grep -Fq 'staging schema contains migration effects; refusing to rewrite migration history' "$recovery_script"
grep -Fq 'billing_staging_migration_partial_state_reverted' "$recovery_script"
grep -Fq 'DROP TABLE "AiSystemProfileVersion"' "$recovery_script"
grep -Fq 'ALTER TABLE "AiSystemProfile" DROP COLUMN "currentVersionId"' "$recovery_script"
grep -Fq 'NOT EXISTS (SELECT 1 FROM pg_extension' "$recovery_script"
grep -Fq '"--rolled-back",' "$recovery_script"
grep -Fq 'billing_staging_migration_failed exit_code=${migration_status}' "$migration_script"
grep -Fq 'pnpm --filter @lyrashield/db exec prisma migrate status 2>&1 || true' "$migration_script"
grep -Fq 'const SYSTEM_ROLE = "app_system_staging"' "$role_script"
grep -Fq 'member_role.rolname = current_user' "$role_script"
grep -Fq 'AND membership.admin_option' "$role_script"
grep -Fq 'AND NOT membership.inherit_option' "$role_script"
grep -Fq 'AND NOT membership.set_option' "$role_script"
grep -Fq 'NOSUPERUSER' "$role_script"
grep -Fq 'NOBYPASSRLS' "$role_script"
grep -Fq 'NOREPLICATION' "$role_script"
grep -Fq 'rolreplication' "$role_script"
grep -Fq 'has unexpected role memberships' "$role_script"
grep -Fq 'PlatformAdminAudit' "$role_script"
grep -Fq 'SYSTEM_TABLES = ["License", "LicenseKey", "LicenseActivation"]' "$role_script"
grep -Fq 'privileges do not match the exact license-table contract' "$role_script"
grep -Fq '"License:DELETE"' "$role_script"
grep -Fq '"LicenseKey:UPDATE"' "$role_script"
grep -Fq 'const E2E_ROLE = "billing_e2e_staging"' "$e2e_role_script"
grep -Fq 'api-version=2025-01-01' "$job_creator"
grep -Fq 'registries: [{server: $registry, identity: $identity}]' "$job_creator"
grep -Fq 'JOB_SECRET_SPECS' "$job_creator"
grep -Fq 'JOB_ENV_SPECS' "$job_creator"
grep -Fq 'secrets: $secrets' "$job_creator"
grep -Fq 'env: $container_env' "$job_creator"
grep -Fq -- '--body @-' "$job_creator"
grep -Fq 'az rest' "$job_creator"
if grep -Fq 'role assignment create' "$job_creator"; then
  echo "FAIL: staging job creation must not require role-assignment writes" >&2
  exit 1
fi

mock_dir=$(mktemp -d)
trap 'rm -rf "$mock_dir"' EXIT
mock_body_prefix="$mock_dir/body"
mock_args_prefix="$mock_dir/args"
printf '0' > "$mock_dir/call-count"
: > "$mock_dir/call-log"
cat > "$mock_dir/az" <<'MOCK_AZ'
#!/usr/bin/env bash
set -euo pipefail
case " $* " in
  *" account show "*) printf '%s\n' 'test-subscription' ;;
  *" containerapp env show "*" --query id "*) printf '%s\n' '/subscriptions/test/resourceGroups/stage/providers/Microsoft.App/managedEnvironments/stage' ;;
  *" containerapp env show "*" --query location "*) printf '%s\n' 'centralindia' ;;
  *" rest "*)
    call_number=$(($(cat "$MOCK_CALL_COUNT_PATH") + 1))
    printf '%s' "$call_number" > "$MOCK_CALL_COUNT_PATH"
    printf '%s\n' rest >> "$MOCK_CALL_LOG_PATH"
    printf '%s\n' "$*" > "${MOCK_ARGS_PREFIX}.${call_number}.txt"
    cat > "${MOCK_BODY_PREFIX}.${call_number}.json"
    ;;
  *" containerapp job secret list "*)
    printf '%s\n' secret-list >> "$MOCK_CALL_LOG_PATH"
    printf '%s\n' 'database-admin-url-lyra-stage-atomic-test'
    ;;
  *" containerapp job show "*) printf '%s\n' 'Succeeded' ;;
  *) printf 'unexpected az call: %s\n' "$*" >&2; exit 1 ;;
esac
MOCK_AZ
chmod +x "$mock_dir/az"

PATH="$mock_dir:$PATH" \
  MOCK_BODY_PREFIX="$mock_body_prefix" \
  MOCK_ARGS_PREFIX="$mock_args_prefix" \
  MOCK_CALL_COUNT_PATH="$mock_dir/call-count" \
  MOCK_CALL_LOG_PATH="$mock_dir/call-log" \
  RESOURCE_GROUP='billing-stage-rg' \
  CONTAINER_ENVIRONMENT='stage-env' \
  REGISTRY='stage.azurecr.io' \
  PULL_IDENTITY_ID='/subscriptions/test/resourceGroups/stage/providers/Microsoft.ManagedIdentity/userAssignedIdentities/pull' \
  IMAGE_SHA='0123456789abcdef0123456789abcdef01234567' \
  JOB_REPLICA_RETRY_LIMIT=1 \
  DATABASE_ADMIN_URL='test-secret-value' \
  JOB_SECRET_SPECS='database-admin-url=DATABASE_ADMIN_URL' \
  JOB_ENV_SPECS=$'DATABASE_ADMIN_URL=secretref:database-admin-url\nE2E_ROLE_ACTION=drop' \
  "$job_creator" \
    'lyra-stage-atomic-test' \
    'stage.azurecr.io/migrate@sha256:0000000000000000000000000000000000000000000000000000000000000000' \
    '/app/test.sh' \
    1200

jq -e '
  .properties.configuration.secrets == [{name: "database-admin-url-lyra-stage-atomic-test", value: "test-secret-value"}] and
  .properties.configuration.replicaRetryLimit == 1 and
  .properties.template.containers[0].env == [
    {name: "E2E_ROLE_ACTION", value: "drop"}
  ]
' "$mock_body_prefix.1.json" >/dev/null
jq -e '
  .properties.template.containers[0].env == [
    {name: "DATABASE_ADMIN_URL", secretRef: "database-admin-url-lyra-stage-atomic-test"},
    {name: "E2E_ROLE_ACTION", value: "drop"}
  ] and
  (.properties.configuration? | not)
' "$mock_body_prefix.2.json" >/dev/null
for mock_args in "$mock_args_prefix".*.txt; do
  grep -Fq -- '--body @-' "$mock_args"
  if grep -Fq 'test-secret-value' "$mock_args"; then
    echo "FAIL: atomic job helper exposed a secret in Azure CLI arguments" >&2
    exit 1
  fi
done
if [ "$(cat "$mock_dir/call-count")" != '2' ]; then
  echo "FAIL: atomic job helper must persist secrets before binding secret references" >&2
  exit 1
fi
if [ "$(tr '\n' ' ' < "$mock_dir/call-log")" != 'rest secret-list rest ' ]; then
  echo "FAIL: atomic job helper must read back secrets before binding secret references" >&2
  exit 1
fi

retry_mock_dir=$(mktemp -d)
(
  trap 'rm -rf "$retry_mock_dir"' EXIT
  cat > "$retry_mock_dir/az" <<'MOCK_AZ_RETRY'
#!/usr/bin/env bash
set -euo pipefail
case " $* " in
  *" containerapp job start "*)
    attempt=$(($(cat "$RETRY_START_COUNT") + 1))
    printf '%s' "$attempt" > "$RETRY_START_COUNT"
    if [ "$attempt" -eq 1 ]; then
      echo "ERROR: (ContainerAppSecretRefNotFound) transient control-plane propagation" >&2
      exit 1
    fi
    printf '%s\n' 'lyra-stage-atomic-test-retry'
    ;;
  *) printf 'unexpected az call: %s\n' "$*" >&2; exit 1 ;;
esac
MOCK_AZ_RETRY
  cat > "$retry_mock_dir/sleep" <<'MOCK_SLEEP'
#!/usr/bin/env bash
exit 0
MOCK_SLEEP
  chmod +x "$retry_mock_dir/az" "$retry_mock_dir/sleep"
  printf '0' > "$retry_mock_dir/start-count"
  execution=$(PATH="$retry_mock_dir:$PATH" RETRY_START_COUNT="$retry_mock_dir/start-count" \
    "$job_starter" 'lyra-stage-atomic-test' 'billing-stage-rg')
  [ "$execution" = 'lyra-stage-atomic-test-retry' ]
  [ "$(cat "$retry_mock_dir/start-count")" = '2' ]
)

grep -Fq 'NOINHERIT NOREPLICATION BYPASSRLS' "$e2e_role_script"
grep -Fq 'VALID UNTIL %L' "$e2e_role_script"
grep -Fq 'E2E_ROLE_TTL_MS = 2 * 60 * 60 * 1_000' "$e2e_role_script"
grep -Fq 'rolvaliduntil' "$e2e_role_script"
grep -Fq 'must not have role memberships' "$e2e_role_script"
grep -Fq "REVOKE %I FROM %I" "$e2e_role_script"
grep -Fq 'REVOKE ALL PRIVILEGES ON ALL TABLES' "$e2e_role_script"
grep -Fq 'DROP ROLE' "$e2e_role_script"
grep -Fq 'BILLING_E2E_DATABASE_URL' "$playwright_config"
grep -Fq 'process.env.DATABASE_SYSTEM_URL = evidenceDatabaseUrl' "$playwright_config"
grep -Fq 'BILLING_STAGING_REGION === "inr"' "$e2e_razorpay"
if grep -Fq 'cf-ipcountry' "$e2e_razorpay"; then
  echo "FAIL: remote Razorpay proof must not spoof a client country header" >&2
  exit 1
fi
if grep -Fq 'cf-ipcountry' "$geo_router"; then
  echo "FAIL: billing routing must not trust a client-supplied country header" >&2
  exit 1
fi
stale_drop_line=$(grep -n 'Drop that stale role before minting a new credential' "$workflow" | cut -d: -f1)
new_password_line=$(grep -n 'e2e_password=$(openssl rand -hex 32)' "$workflow" | cut -d: -f1)
if [ -z "$stale_drop_line" ] || [ -z "$new_password_line" ] || [ "$stale_drop_line" -ge "$new_password_line" ]; then
  echo "FAIL: stale E2E role recovery must run before a new credential is provisioned" >&2
  exit 1
fi
cleanup_block=$(sed -n '/- name: Recover and remove disposable E2E database access/,$p' "$workflow")
cleanup_stop_line=$(grep -n 'stop_job_executions "$job"' <<< "$cleanup_block" | head -1 | cut -d: -f1)
cleanup_delete_line=$(grep -n 'az containerapp job delete' <<< "$cleanup_block" | head -1 | cut -d: -f1)
if [ -z "$cleanup_stop_line" ] || [ -z "$cleanup_delete_line" ] || \
  [ "$cleanup_stop_line" -ge "$cleanup_delete_line" ]; then
  echo "FAIL: always cleanup must stop executions before deleting jobs" >&2
  exit 1
fi
proof_env_block=$(sed -n '/proof_env=(/,/create-billing-staging-job.sh/p' "$workflow")
for required_job_env in \
  'NODE_ENV=production' \
  'TRUSTED_PROXY_IP_HEADER=x-forwarded-for' \
  'LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=0' \
  'PLATFORM_ADMIN_EMAILS=${PLATFORM_ADMIN_EMAILS}'; do
  if ! grep -Fq "$required_job_env" <<< "$proof_env_block"; then
    echo "FAIL: proof job env is missing ${required_job_env}" >&2
    exit 1
  fi
done
grep -Fq '"BILLING_STAGING_REGION="' "$production_workflow"
app_runtime_block=$(sed -n '/- name: Create or update public disposable staging app/,/- name: Run proof with disposable E2E evidence role/p' "$workflow")
if grep -Fq 'BILLING_E2E_DATABASE_URL' <<< "$app_runtime_block"; then
  echo "FAIL: disposable E2E database credential must not be bound to the web app" >&2
  exit 1
fi
grep -Fq "retry_containerapp_write()" <<< "$app_runtime_block"
grep -Fq "(ConflictingConcurrentWriteNotAllowed)" <<< "$app_runtime_block"
for retried_write in \
  'billing staging identity assignment|az containerapp identity assign' \
  'billing staging registry configuration|az containerapp registry set' \
  'billing staging secret configuration|az containerapp secret set' \
  'billing staging revision update|az containerapp update'; do
  IFS='|' read -r label command <<< "$retried_write"
  if ! awk -v retry="retry_containerapp_write \"$label\"" -v command="$command" '
    index($0, retry) { getline; found = index($0, command) }
    END { exit found ? 0 : 1 }
  ' <<< "$app_runtime_block"; then
    echo "FAIL: $command must use bounded conflict retry" >&2
    exit 1
  fi
done
if grep -Eq 'console\.(log|error).*PASSWORD|console\.(log|error).*password' "$role_script"; then
  echo "FAIL: role script may log a password" >&2
  exit 1
fi
if grep -Eq 'console\.(log|error).*PASSWORD|console\.(log|error).*password' "$e2e_role_script"; then
  echo "FAIL: E2E role script may log a password" >&2
  exit 1
fi

if grep -E 'uses: [^@]+@(main|master|v[0-9]+)$' "$workflow"; then
  echo "FAIL: action is not SHA-pinned" >&2
  exit 1
fi

grep -Fq 'LYRASHIELD_DEPLOYMENT_ENVIRONMENT === "billing-staging"' "$proxy"
grep -Fq '"/billing/webhook"' "$proxy"
grep -Fq '"/api/ready"' "$proxy"
grep -Fq '!pathname.startsWith("/_next/static/")' "$proxy"
grep -Fq '!hasBillingStagingAccess(request)' "$proxy"
grep -Fq 'httpOnly: true' "$access_route"
grep -Fq 'secure: true' "$access_route"
grep -Fq 'sameSite: "lax"' "$access_route"
grep -Fq 'page.goto("/staging/access")' "$e2e_fixture"
grep -Fq 'getByLabel("Staging access code")' "$e2e_fixture"
grep -Fq 'const stagingAccessToken = process.env.BILLING_E2E_STAGING_ACCESS_TOKEN' "$e2e_fixture"
if grep -Fq 'BILLING_E2E_STAGING_ACCESS_TOKEN?.trim()' "$e2e_fixture"; then
  echo "FAIL: staging access token must remain byte-for-byte intact" >&2
  exit 1
fi
if grep -Fq 'extraHTTPHeaders' "$e2e_fixture"; then
  echo "FAIL: staging access must not persist as a browser-wide header" >&2
  exit 1
fi

job_start_count=$(grep -Fc 'execution=$(.github/scripts/start-billing-staging-job.sh "$job" "$RESOURCE_GROUP")' "$workflow")
job_provision_wait_count=$(grep -Fc 'provisioning_state=$(az containerapp job show' "$workflow")
if [ "$job_start_count" -ne "$job_provision_wait_count" ]; then
  echo "FAIL: every Container Apps job start must wait for provisioning" >&2
  exit 1
fi

# Import the production env module with the one-shot job's non-secret contract.
# Invalid or omitted runtime-only settings must fail here before a staging run.
(
  cd "$repo"
  NODE_ENV=production \
    DATABASE_URL='postgresql://billing_e2e_staging:test@db.example.invalid:5432/staging' \
    DATABASE_SYSTEM_URL='postgresql://billing_e2e_staging:test@db.example.invalid:5432/staging' \
    BETTER_AUTH_SECRET='billing-staging-static-smoke-secret' \
    BETTER_AUTH_URL='https://lyrashield-billing-staging.test.centralindia.azurecontainerapps.io' \
    NEXT_PUBLIC_APP_URL='https://lyrashield-billing-staging.test.centralindia.azurecontainerapps.io' \
    NEXT_PUBLIC_MARKETING_URL='https://lyrashieldai.com' \
    TRUSTED_PROXY_IP_HEADER='x-forwarded-for' \
    LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=0 \
    PLATFORM_ADMIN_EMAILS='ecryptoguru@gmail.com,ankit@lyrashieldai.com' \
    LYRASHIELD_DEPLOYMENT_ENVIRONMENT='billing-staging' \
    BILLING_STAGING_ADMISSION='restricted' \
    BILLING_STAGING_ACCESS_TOKEN='static-smoke-access-token-value-x' \
    BILLING_STAGING_REGION='usd' \
    POLAR_BILLING_ADMISSION=off \
    POLAR_LOCAL_BILLING_ADMISSION=off \
    RAZORPAY_BILLING_ADMISSION=off \
    RAZORPAY_LOCAL_BILLING_ADMISSION=off \
    POLAR_ENVIRONMENT=sandbox \
    RAZORPAY_KEY_ID=rzp_test_static_smoke \
    pnpm --filter @lyrashield/db exec tsx -e \
      '(async () => { await import("../../packages/config/src/index.ts") })()'
)

echo "Billing staging workflow static contract passed."
