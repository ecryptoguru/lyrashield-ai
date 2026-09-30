#!/usr/bin/env bash
set -euo pipefail

# Workflow step: Deploy app Container App
step_deploy-app-container-app() {
  source ops/deployment/containerapp.sh
  # A secretref to a secret the Container App does not define is a hard
  # failure, so these are referenced only when the sync step above
  # actually provisioned them.
  OAUTH_ENV=()
  if [ "${GITHUB_APP_CLIENT_ID_CONFIGURED}" = "true" ] && [ "${GITHUB_APP_CLIENT_SECRET_CONFIGURED}" = "true" ]; then
    OAUTH_ENV=("GITHUB_APP_CLIENT_ID=secretref:github-app-client-id" "GITHUB_APP_CLIENT_SECRET=secretref:github-app-client-secret")
  fi
  EMAIL_ENV=()
  if [ "$EMAIL_VERIFICATION_REQUIRED" = "1" ]; then
    EMAIL_ENV=("BREVO_API_KEY=secretref:brevo-api-key")
  fi
  MYRA_ENV=()
  if [ "${MYRA_AZURE_OPENAI_API_KEY_CONFIGURED}" = "true" ]; then
    MYRA_ENV+=("MYRA_AZURE_OPENAI_API_KEY=secretref:myra-aoai-key")
  fi
  if [ "${TURNSTILE_SECRET_KEY_CONFIGURED}" = "true" ]; then
    MYRA_ENV+=("TURNSTILE_SECRET_KEY=secretref:turnstile-secret")
  fi
  if [ "${MYRA_GOOGLE_CLIENT_SECRET_CONFIGURED}" = "true" ]; then
    MYRA_ENV+=("MYRA_GOOGLE_CLIENT_SECRET=secretref:myra-g-secret")
  fi
  if [ "${MYRA_GOOGLE_REFRESH_TOKEN_CONFIGURED}" = "true" ]; then
    MYRA_ENV+=("MYRA_GOOGLE_REFRESH_TOKEN=secretref:myra-g-refresh")
  fi
  probe_dir=$(mktemp -d)
  trap 'rm -rf "$probe_dir"' EXIT
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
    -subj "/CN=lyrashield-deploy-probe" \
    -keyout "$probe_dir/key.pem" -out "$probe_dir/cert.pem" >/dev/null 2>&1
  DEPLOY_PROBE_CERT_SHA256=$(openssl x509 -in "$probe_dir/cert.pem" -outform DER | sha256sum | cut -d' ' -f1)
  case "${CLOUDFLARE_ORIGIN_MTLS}" in
    off) CLIENT_CERT_MODE=Ignore ;;
    required) CLIENT_CERT_MODE=Require ;;
    *) echo "::error::Invalid CLOUDFLARE_ORIGIN_MTLS mode."; exit 1 ;;
  esac
  CONTAINER_APP_RESOURCE_ID=$(az containerapp show \
    --name "$AZURE_APP_CONTAINER_APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --query id \
    --output tsv)
  PREVIOUS_CLIENT_CERT_MODE=$(ca_client_cert_mode_get "$CONTAINER_APP_RESOURCE_ID")
  PREVIOUS_CLIENT_CERT_MODE=${PREVIOUS_CLIENT_CERT_MODE:-Ignore}
  echo "previous_client_cert_mode=${PREVIOUS_CLIENT_CERT_MODE}" >> "$GITHUB_OUTPUT"
  ca_client_cert_mode_set "$CONTAINER_APP_RESOURCE_ID" "$CLIENT_CERT_MODE"
  ca_client_cert_mode_wait "$CONTAINER_APP_RESOURCE_ID" "$CLIENT_CERT_MODE" 24 5 || {
    echo "::error::Container Apps client certificate mode readback did not match the protected configuration."
    exit 1
  }
  ca_retry_update az containerapp update \
    --name "$AZURE_APP_CONTAINER_APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --image "${IMAGE}" \
    --remove-env-vars \
      LYRASHIELD_DEPLOYMENT_ENVIRONMENT \
      BILLING_STAGING_ADMISSION \
      BILLING_STAGING_ACCESS_TOKEN \
      BILLING_STAGING_REGION \
      MYRA_ALLOWED_EMAILS \
      MYRA_MODEL_FAST \
      MYRA_MODEL_DEEP \
      MYRA_EMBED_MODEL \
      MYRA_AZURE_OPENAI_DEPLOYMENT \
    --set-env-vars \
      "NEXT_PUBLIC_APP_URL=${APP_URL}" \
      "NEXT_PUBLIC_MARKETING_URL=${MARKETING_URL}" \
      "BETTER_AUTH_URL=${APP_URL}" \
      "PLATFORM_ADMIN_EMAILS=${PLATFORM_ADMIN_EMAILS}" \
      "IP_HASH_SALT=secretref:ip-hash-salt" \
      "LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=${REQUIRE_EMAIL_VERIFICATION}" \
      "LYRASHIELD_PRODUCT_REVISION=${DEPLOY_SHA}" \
      "CLOUDFLARE_ORIGIN_MTLS=${CLOUDFLARE_ORIGIN_MTLS}" \
      "CLOUDFLARE_AOP_CERT_SHA256=${CLOUDFLARE_AOP_CERT_SHA256}" \
      "DEPLOY_PROBE_CERT_SHA256=${DEPLOY_PROBE_CERT_SHA256}" \
      "POLAR_ENVIRONMENT=${POLAR_ENVIRONMENT}" \
      "POLAR_ACCESS_TOKEN=secretref:polar-access-token" \
      "POLAR_WEBHOOK_SECRET=secretref:polar-webhook-secret" \
      "POLAR_PRODUCT_IDS=${POLAR_PRODUCT_IDS}" \
      "POLAR_LOCAL_PRODUCT_IDS=${POLAR_LOCAL_PRODUCT_IDS}" \
      "POLAR_BILLING_ADMISSION=${POLAR_BILLING_ADMISSION}" \
      "POLAR_LOCAL_BILLING_ADMISSION=${POLAR_LOCAL_BILLING_ADMISSION}" \
      "RAZORPAY_KEY_ID=secretref:razorpay-key-id" \
      "RAZORPAY_KEY_SECRET=secretref:razorpay-key-secret" \
      "RAZORPAY_WEBHOOK_SECRET=secretref:razorpay-webhook-secret" \
      "RAZORPAY_PLAN_IDS=${RAZORPAY_PLAN_IDS}" \
      "RAZORPAY_BILLING_ADMISSION=${RAZORPAY_BILLING_ADMISSION}" \
      "RAZORPAY_LOCAL_BILLING_ADMISSION=${RAZORPAY_LOCAL_BILLING_ADMISSION}" \
      "BILLING_CANARY_WORKSPACE_IDS=${BILLING_CANARY_WORKSPACE_IDS}" \
      "REDIS_URL=secretref:bullmq-redis-url" \
      "UPSTASH_REDIS_REST_URL=secretref:upstash-redis-rest-url" \
      "UPSTASH_REDIS_REST_TOKEN=secretref:upstash-redis-rest-token" \
      "LYRASHIELD_EVIDENCE_KEK=secretref:${LYRASHIELD_EVIDENCE_KEK_SECRET}" \
      "LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF=${LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF}" \
      "LYRASHIELD_EVIDENCE_KEK_KEYRING=secretref:${LYRASHIELD_EVIDENCE_KEK_KEYRING_SECRET}" \
      "S3_ENDPOINT=secretref:evidence-s3-endpoint" \
      "S3_BUCKET=secretref:evidence-s3-bucket" \
      "S3_ACCESS_KEY=secretref:evidence-s3-access" \
      "S3_SECRET_KEY=secretref:evidence-s3-secret" \
      "S3_REGION=auto" \
      "GITHUB_APP_ID=secretref:github-app-id" \
      "GITHUB_APP_SLUG=secretref:github-app-slug" \
      "GITHUB_APP_PRIVATE_KEY=secretref:github-app-private-key" \
      "GITHUB_WEBHOOK_SECRET=secretref:github-webhook-secret" \
      "MYRA_PUBLIC_ENABLED=${MYRA_PUBLIC_ENABLED}" \
      "MYRA_DASHBOARD_ENABLED=${MYRA_DASHBOARD_ENABLED}" \
      "MYRA_OPERATOR_ENABLED=${MYRA_OPERATOR_ENABLED}" \
      "MYRA_WRITES_ENABLED=${MYRA_WRITES_ENABLED}" \
      "MYRA_PUBLIC_BOOKING_ENABLED=${MYRA_PUBLIC_BOOKING_ENABLED}" \
      "MYRA_GENERATION_ENABLED=${MYRA_GENERATION_ENABLED}" \
      "MYRA_PROVIDER=${MYRA_PROVIDER}" \
      "MYRA_CALENDAR_PROVIDER=${MYRA_CALENDAR_PROVIDER}" \
      "MYRA_AZURE_OPENAI_ENDPOINT=${MYRA_AZURE_OPENAI_ENDPOINT}" \
      "MYRA_MODEL=${MYRA_MODEL}" \
      "MYRA_MONTHLY_BUDGET_USD=${MYRA_MONTHLY_BUDGET_USD}" \
      "MYRA_GOOGLE_CLIENT_ID=${MYRA_GOOGLE_CLIENT_ID}" \
      "MYRA_GOOGLE_CALENDAR_ID=${MYRA_GOOGLE_CALENDAR_ID}" \
      "MYRA_SUPPORT_NOTIFY_EMAIL=${MYRA_SUPPORT_NOTIFY_EMAIL}" \
      "${MYRA_ENV[@]}" \
      "${EMAIL_ENV[@]}" \
      "${OAUTH_ENV[@]}" \
    --output none
  candidate=$(ca_candidate "$AZURE_APP_CONTAINER_APP_NAME" "$AZURE_RESOURCE_GROUP") || {
    echo "::error::Azure did not return the app candidate revision and FQDN. Production traffic was not changed."
    exit 1
  }
  IFS=$'	' read -r CANDIDATE_REVISION CANDIDATE_FQDN <<< "$candidate"
  echo "revision=$CANDIDATE_REVISION" >> "$GITHUB_OUTPUT"
  echo "fqdn=$CANDIDATE_FQDN" >> "$GITHUB_OUTPUT"
  if [ "${CLOUDFLARE_ORIGIN_MTLS}" = "required" ]; then
    for path in /api/ready /api/ready/evidence; do
      for attempt in $(seq 1 24); do
        if curl --fail --silent --show-error --max-time 10 \
          --cert "$probe_dir/cert.pem" --key "$probe_dir/key.pem" \
          "https://${CANDIDATE_FQDN}${path}"; then
          break
        fi
        if [ "$attempt" = "24" ]; then
          echo "::error::mTLS deployment probe failed for ${path}. Production traffic was not changed."
          exit 1
        fi
        sleep 5
      done
    done
    echo "mTLS candidate probe passed with ephemeral certificate fingerprint only."
  fi
}

# Workflow step: Deploy scanner Container App
step_deploy-scanner-container-app() {
  source ops/deployment/containerapp.sh
  EMAIL_ENV=()
  if [ "$EMAIL_VERIFICATION_REQUIRED" = "1" ]; then
    EMAIL_ENV=("BREVO_API_KEY=secretref:brevo-api-key")
  fi
  az containerapp update \
    --name "$AZURE_SCANNER_CONTAINER_APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --image "${IMAGE}" \
    --min-replicas 1 \
    --remove-env-vars \
      LYRASHIELD_DEPLOYMENT_ENVIRONMENT \
      BILLING_STAGING_ADMISSION \
      BILLING_STAGING_ACCESS_TOKEN \
      BILLING_STAGING_REGION \
      GITHUB_APP_ID \
      GITHUB_APP_SLUG \
      GITHUB_APP_PRIVATE_KEY \
      GITHUB_WEBHOOK_SECRET \
      GITHUB_APP_CLIENT_ID \
      GITHUB_APP_CLIENT_SECRET \
      MYRA_AZURE_OPENAI_DEPLOYMENT \
    --set-env-vars \
      "NEXT_PUBLIC_APP_URL=${SCANNER_URL}" \
      "NEXT_PUBLIC_MARKETING_URL=${MARKETING_URL}" \
      "BETTER_AUTH_URL=${APP_URL}" \
      "PLATFORM_ADMIN_EMAILS=${PLATFORM_ADMIN_EMAILS}" \
      "IP_HASH_SALT=secretref:ip-hash-salt" \
      "LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=${REQUIRE_EMAIL_VERIFICATION}" \
      "POLAR_BILLING_ADMISSION=${POLAR_BILLING_ADMISSION}" \
      "POLAR_LOCAL_BILLING_ADMISSION=${POLAR_LOCAL_BILLING_ADMISSION}" \
      "RAZORPAY_BILLING_ADMISSION=${RAZORPAY_BILLING_ADMISSION}" \
      "RAZORPAY_LOCAL_BILLING_ADMISSION=${RAZORPAY_LOCAL_BILLING_ADMISSION}" \
      "BILLING_CANARY_WORKSPACE_IDS=" \
      "CLOUDFLARE_ORIGIN_MTLS=off" \
      "CLOUDFLARE_AOP_CERT_SHA256=" \
      "DEPLOY_PROBE_CERT_SHA256=" \
      "REDIS_URL=secretref:bullmq-redis-url" \
      "UPSTASH_REDIS_REST_URL=secretref:upstash-redis-rest-url" \
      "UPSTASH_REDIS_REST_TOKEN=secretref:upstash-redis-rest-token" \
      "${EMAIL_ENV[@]}" \
    --output none
  candidate=$(ca_candidate "$AZURE_SCANNER_CONTAINER_APP_NAME" "$AZURE_RESOURCE_GROUP") || {
    echo "::error::Azure did not return the scanner candidate revision and FQDN. Production traffic was not changed."
    exit 1
  }
  IFS=$'	' read -r CANDIDATE_REVISION CANDIDATE_FQDN <<< "$candidate"
  echo "revision=$CANDIDATE_REVISION" >> "$GITHUB_OUTPUT"
  echo "fqdn=$CANDIDATE_FQDN" >> "$GITHUB_OUTPUT"
}

# Workflow step: Deploy egress-proxy Container App
step_deploy-egress-proxy-container-app() {
  source ops/deployment/containerapp.sh
  az containerapp update \
    --name "$AZURE_EGRESS_PROXY_CONTAINER_APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --image "$IMAGE" \
    --min-replicas 1 \
    --max-replicas 1 \
    --output none
  candidate=$(ca_candidate "$AZURE_EGRESS_PROXY_CONTAINER_APP_NAME" "$AZURE_RESOURCE_GROUP") || {
    echo "::error::Azure did not return the egress-proxy candidate revision and FQDN. Production traffic was not changed."
    exit 1
  }
  IFS=$'	' read -r CANDIDATE_REVISION CANDIDATE_FQDN <<< "$candidate"
  # Relay budgets/revocation have one registered authority per process.
  # A replacement process rejects old grants; replicas must not split admission.
  RELAY_SCALE=$(az containerapp revision show \
    --name "$AZURE_EGRESS_PROXY_CONTAINER_APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --revision "$CANDIDATE_REVISION" \
    --query '[properties.template.scale.minReplicas, properties.template.scale.maxReplicas]' \
    --output tsv)
  if [ "$(echo "$RELAY_SCALE" | xargs)" != "1 1" ]; then
    echo "::error::Egress relay candidate must have exactly one replica. Production traffic was not changed."
    exit 1
  fi
  echo "revision=$CANDIDATE_REVISION" >> "$GITHUB_OUTPUT"
  echo "fqdn=$CANDIDATE_FQDN" >> "$GITHUB_OUTPUT"
}

# Workflow step: Smoke candidate revisions
step_smoke-candidate-revisions() {
  source ops/deployment/azure-vm-run-command.sh
  smoke_candidate() {
    local label="$1"
    local name="$2"
    local revision="$3"
    local fqdn="$4"
    local path="$5"
    if [ -z "$fqdn" ]; then return 0; fi
    for attempt in $(seq 1 120); do
      if [ "$attempt" = "61" ]; then
        echo "::warning::${label} candidate missed its first readiness window; restarting the zero-traffic revision once."
        timeout --foreground 180s az containerapp revision restart \
          --name "$name" \
          --resource-group "$RG" \
          --revision "$revision" \
          --output none
      fi
      if curl --fail --silent --show-error --max-time 5 "https://${fqdn}${path}"; then
        echo "${label} candidate health OK"
        return 0
      fi
      echo "${label} candidate not ready (attempt ${attempt}), retrying in 5s..."
      sleep 5
    done
    echo "::error::${label} candidate health failed after one bounded revision restart. Production traffic was not changed."
    return 1
  }
  smoke_egress_candidate() {
    if [ -z "$EGRESS_NAME" ]; then return 0; fi
    for attempt in $(seq 1 120); do
      if [ "$attempt" = "61" ]; then
        echo "::warning::egress-proxy candidate missed its first readiness window; restarting the zero-traffic revision once."
        timeout --foreground 180s az containerapp revision restart \
          --name "$EGRESS_NAME" \
          --resource-group "$RG" \
          --revision "$EGRESS_REVISION" \
          --output none
      fi
      local health
      local running
      health=$(az containerapp revision show \
        --name "$EGRESS_NAME" \
        --resource-group "$RG" \
        --revision "$EGRESS_REVISION" \
        --query properties.healthState \
        --output tsv)
      running=$(az containerapp revision show \
        --name "$EGRESS_NAME" \
        --resource-group "$RG" \
        --revision "$EGRESS_REVISION" \
        --query properties.runningState \
        --output tsv)
      if [ "$health" = "Healthy" ] && [[ "$running" == Running* ]]; then
        local result
        result=$(azure_vm_run_command_with_retry \
          --name "$WORKER_VM_NAME" \
          --resource-group "$RG" \
          --command-id RunShellScript \
          --scripts "curl --fail --silent --show-error --max-time 10 https://${EGRESS_FQDN}/health && echo EGRESS_HEALTH_OK" \
          --query 'value[0].message' \
          --output tsv)
        if grep -q EGRESS_HEALTH_OK <<< "$result"; then
          echo "egress-proxy candidate health OK from worker VM"
          return 0
        fi
        echo "::error::Worker VM could not reach the healthy egress-proxy candidate."
        return 1
      fi
      echo "egress-proxy candidate not ready (attempt ${attempt}), retrying in 5s..."
      sleep 5
    done
    echo "::error::egress-proxy candidate health failed after one bounded revision restart. Production traffic was not changed."
    return 1
  }
  if [ "$CLOUDFLARE_ORIGIN_MTLS" = "required" ]; then
    APP_SMOKE_PID=""
    echo "App mTLS candidate readiness already passed with ephemeral client certificate."
  else
    smoke_candidate app "$APP_NAME" "$APP_REVISION" "$APP_FQDN" /api/ready & APP_SMOKE_PID=$!
  fi
  smoke_candidate scanner "$SCANNER_NAME" "$SCANNER_REVISION" "$SCANNER_FQDN" /api/ready & SCANNER_SMOKE_PID=$!
  smoke_egress_candidate & EGRESS_SMOKE_PID=$!
  CANDIDATE_SMOKE_FAILED=0
  if [ -z "$APP_SMOKE_PID" ]; then
    :
  elif wait "$APP_SMOKE_PID"; then
    if [ -n "$APP_FQDN" ] && ! curl --fail --silent --show-error --max-time 5 "https://${APP_FQDN}/api/ready/evidence"; then
      echo "::error::app candidate evidence configuration is not ready. Production traffic was not changed."
      CANDIDATE_SMOKE_FAILED=1
    fi
  else
    CANDIDATE_SMOKE_FAILED=1
  fi
  wait "$SCANNER_SMOKE_PID" || CANDIDATE_SMOKE_FAILED=1
  wait "$EGRESS_SMOKE_PID" || CANDIDATE_SMOKE_FAILED=1
  exit "$CANDIDATE_SMOKE_FAILED"
}

# Workflow step: Verify worker queues are empty before traffic promotion
step_verify-worker-queues-are-empty-before-traffic-promotion() {
  source ops/deployment/azure-vm-run-command.sh
  payload=$(base64 --wrap=0 .github/scripts/promote-worker-vm.sh)
  # Until the first promotion installs worker-env.sh on the host the
  # script sources the copy embedded in this payload.
  worker_env_payload=$(base64 --wrap=0 ops/worker/worker-env.sh)
  result=$(azure_vm_run_command_with_retry \
    --name "$WORKER_VM_NAME" --resource-group "$RG" \
    --command-id RunShellScript \
    --scripts "printf '%s' '$worker_env_payload' | base64 -d > /tmp/lyrashield-worker-env.sh && printf '%s' '$payload' | base64 -d | LYRASHIELD_WORKER_ENV_LIB=/tmp/lyrashield-worker-env.sh timeout --kill-after=10s 150s sh -s -- --preflight" \
    --query 'value[0].message' --output tsv)
  printf '%s\n' "$result"
  grep -q "Worker empty-queue preflight passed" <<< "$result"
}

# Workflow step: Promote healthy candidate revisions
step_promote-healthy-candidate-revisions() {
  source ops/deployment/containerapp.sh
  restore_previous() {
    if [ "${WEBHOOK_CLAIMS_CUTOVER:-false}" = true ]; then
      echo "::error::Maintenance cutover keeps incompatible previous writers disabled."
      return 0
    fi
    ca_set_traffic "$APP_NAME" "$APP_PREVIOUS" "$RG" || true
    ca_set_traffic "$SCANNER_NAME" "$SCANNER_PREVIOUS" "$RG" || true
    ca_set_traffic "$EGRESS_NAME" "$EGRESS_PREVIOUS" "$RG" || true
  }
  if ! ca_set_traffic "$APP_NAME" "$APP_CANDIDATE" "$RG" || \
     ! ca_set_traffic "$SCANNER_NAME" "$SCANNER_CANDIDATE" "$RG" || \
     ! ca_set_traffic "$EGRESS_NAME" "$EGRESS_CANDIDATE" "$RG"; then
    echo "::error::Candidate promotion failed. Restoring every previous traffic target."
    restore_previous
    exit 1
  fi
}

# Workflow step: Smoke production traffic
step_smoke-production-traffic() {
  source ops/deployment/azure-vm-run-command.sh
  smoke_public() {
    local label="$1"
    local url="$2"
    if [ -z "$url" ]; then return 0; fi
    for attempt in $(seq 1 12); do
      if curl --fail --silent --show-error --max-time 10 "$url"; then
        echo "${label} production health OK"
        return 0
      fi
      echo "${label} production health not ready (attempt ${attempt}), retrying in 10s..."
      sleep 10
    done
    echo "::error::${label} production health failed after promotion."
    return 1
  }
  smoke_egress_from_worker() {
    local url="$1"
    if [ -z "$url" ]; then return 0; fi
    local result
    result=$(azure_vm_run_command_with_retry \
      --name "$WORKER_VM_NAME" \
      --resource-group "$RG" \
      --command-id RunShellScript \
      --scripts "curl --fail --silent --show-error --max-time 10 ${url} && echo EGRESS_HEALTH_OK" \
      --query 'value[0].message' \
      --output tsv)
    grep -q EGRESS_HEALTH_OK <<< "$result"
  }
  EGRESS_URL=""
  if [ -n "$EGRESS_NAME" ]; then
    EGRESS_FQDN=$(az containerapp show \
      --name "$EGRESS_NAME" \
      --resource-group "$RG" \
      --query properties.configuration.ingress.fqdn \
      --output tsv)
    if [ -z "$EGRESS_FQDN" ]; then
      echo "::error::Azure did not return the egress-proxy production FQDN."
      exit 1
    fi
    EGRESS_URL="https://${EGRESS_FQDN}/health"
  fi
  smoke_public app "${APP_URL}/api/ready"
  smoke_public scanner "${SCANNER_URL}/api/ready"
  smoke_egress_from_worker "$EGRESS_URL"
}

# Workflow step: Deactivate superseded Container App revisions
step_deactivate-superseded-container-app-revisions() {
  source ops/deployment/containerapp.sh
  CLEANUP_FAILED=0
  ca_deactivate_superseded app "$APP_NAME" "$APP_CURRENT" "$APP_ROLLBACK" "$RG" || CLEANUP_FAILED=1
  ca_deactivate_superseded scanner "$SCANNER_NAME" "$SCANNER_CURRENT" "$SCANNER_ROLLBACK" "$RG" || CLEANUP_FAILED=1
  ca_deactivate_superseded egress-proxy "$EGRESS_NAME" "$EGRESS_CURRENT" "$EGRESS_ROLLBACK" "$RG" || CLEANUP_FAILED=1
  exit "$CLEANUP_FAILED"
}

# Workflow step: Remove excess scanner secrets
step_remove-excess-scanner-secrets() {
  mapfile -t existing_secrets < <(az containerapp secret list \
    --name "$SCANNER_NAME" \
    --resource-group "$RG" \
    --query '[].name' \
    --output tsv)
  excess_secrets=()
  for secret in \
    github-app-id \
    github-app-slug \
    github-app-private-key \
    github-webhook-secret \
    github-app-client-id \
    github-app-client-secret
  do
    if printf '%s\n' "${existing_secrets[@]}" | grep -Fxq "$secret"; then
      excess_secrets+=("$secret")
    fi
  done
  if [ "${#excess_secrets[@]}" -eq 0 ]; then
    echo "Public scanner has no GitHub App secrets."
    exit 0
  fi
  az containerapp secret remove \
    --name "$SCANNER_NAME" \
    --resource-group "$RG" \
    --secret-names "${excess_secrets[@]}" \
    --output none
}

# Workflow step: Promote verified worker digest on VM
step_promote-verified-worker-digest-on-vm() {
  source ops/deployment/azure-vm-run-command.sh
  payload=$(base64 --wrap=0 .github/scripts/promote-worker-vm.sh)
  # Until the first promotion installs worker-env.sh on the host the
  # script sources the copy embedded in this payload.
  worker_env_payload=$(base64 --wrap=0 ops/worker/worker-env.sh)
  worker_ref="${WORKER_IMAGE%@*}@${WORKER_DIGEST}"
  promotion_prefix=""
  promotion_flag=""
  if [ "${WEBHOOK_CLAIMS_CUTOVER:-false}" = true ]; then
    : "${LYRASHIELD_ADMISSION_STOP_RECEIPT:?}" "${LYRASHIELD_ADMISSION_STOP_OWNER:?}" "${LYRASHIELD_WEBHOOK_CUTOVER_RUN_ID:?}"
    [[ "$LYRASHIELD_ADMISSION_STOP_OWNER" =~ ^[0-9]+:[0-9]+$ && "$LYRASHIELD_WEBHOOK_CUTOVER_RUN_ID" =~ ^[0-9]+$ ]] || exit 1
    receipt_payload=$(printf '%s' "$LYRASHIELD_ADMISSION_STOP_RECEIPT" | base64 --wrap=0)
    promotion_prefix="LYRASHIELD_ADMISSION_STOP_RECEIPT=\$(printf '%s' '$receipt_payload' | base64 -d) LYRASHIELD_ADMISSION_STOP_OWNER='$LYRASHIELD_ADMISSION_STOP_OWNER' LYRASHIELD_WEBHOOK_CUTOVER_RUN_ID='$LYRASHIELD_WEBHOOK_CUTOVER_RUN_ID' "
    promotion_flag="--webhook-claims-cutover "
  fi
  export AZURE_VM_RUN_COMMAND_TIMEOUT_SECONDS=1800
  result=$(azure_vm_run_command_with_retry \
    --name "$WORKER_VM_NAME" \
    --resource-group "$RG" \
    --command-id RunShellScript \
    --scripts "printf '%s' '$worker_env_payload' | base64 -d > /tmp/lyrashield-worker-env.sh && printf '%s' '$payload' | base64 -d | LYRASHIELD_WORKER_ENV_LIB=/tmp/lyrashield-worker-env.sh ${promotion_prefix}sh -s -- ${promotion_flag}'$worker_ref' '$DEPLOY_SHA' '$ENGINE_REVISION'" \
    --query 'value[0].message' \
    --output tsv)
  printf '%s\n' "$result"
  if [ "${WEBHOOK_CLAIMS_CUTOVER:-false}" = true ]; then
    grep -q "Worker webhook cutover passed for ${WORKER_DIGEST}; scan admission held" <<< "$result"
  else
    grep -q "Worker promotion passed for ${WORKER_DIGEST}" <<< "$result"
  fi
}

# Workflow step: Roll back production traffic on health failure
step_roll-back-production-traffic-on-health-failure() {
  source ops/deployment/containerapp.sh
  source ops/deployment/azure-vm-run-command.sh
  rollback_egress() {
    local name="$1"
    local revision="$2"
    local smoke_url="$3"
    if [ -z "$name" ]; then return 0; fi
    az containerapp revision activate \
      --name "$name" \
      --resource-group "$RG" \
      --revision "$revision" \
      --output none
    az containerapp ingress traffic set \
      --name "$name" \
      --resource-group "$RG" \
      --revision-weight "$revision=100" \
      --output none
    local result
    result=$(azure_vm_run_command_with_retry \
      --name "$WORKER_VM_NAME" \
      --resource-group "$RG" \
      --command-id RunShellScript \
      --scripts "curl --fail --silent --show-error --max-time 10 ${smoke_url} && echo EGRESS_HEALTH_OK" \
      --query 'value[0].message' \
      --output tsv)
    grep -q EGRESS_HEALTH_OK <<< "$result"
  }
  EGRESS_SMOKE_URL=""
  if [ -n "$EGRESS_NAME" ]; then
    EGRESS_FQDN=$(az containerapp show \
      --name "$EGRESS_NAME" \
      --resource-group "$RG" \
      --query properties.configuration.ingress.fqdn \
      --output tsv)
    EGRESS_SMOKE_URL="https://${EGRESS_FQDN}/health"
  fi
  ROLLBACK_FAILED=0
  ca_rollback_revision app "$APP_NAME" "$APP_PREVIOUS" "$APP_SMOKE_URL" "$RG" || ROLLBACK_FAILED=1
  ca_rollback_revision scanner "$SCANNER_NAME" "$SCANNER_PREVIOUS" "$SCANNER_SMOKE_URL" "$RG" || ROLLBACK_FAILED=1
  rollback_egress "$EGRESS_NAME" "$EGRESS_PREVIOUS" "$EGRESS_SMOKE_URL" || ROLLBACK_FAILED=1
  if [ "$ROLLBACK_FAILED" -ne 0 ]; then
    echo "::error::One or more previous revisions did not recover. Manual recovery required."
    exit 1
  fi
}

# Workflow step: Restore prior ingress mode after failed rollout
step_restore-prior-ingress-mode-after-failed-rollout() {
  source ops/deployment/containerapp.sh
  case "$PREVIOUS_CLIENT_CERT_MODE" in
    Ignore|Require) ;;
    *) echo "::error::Refusing to restore an unexpected Container Apps client certificate mode."; exit 1 ;;
  esac
  APP_RESOURCE_ID=$(az containerapp show \
    --name "$APP_NAME" \
    --resource-group "$RG" \
    --query id \
    --output tsv)
  ca_client_cert_mode_set "$APP_RESOURCE_ID" "$PREVIOUS_CLIENT_CERT_MODE"
  if ! ca_client_cert_mode_wait "$APP_RESOURCE_ID" "$PREVIOUS_CLIENT_CERT_MODE" 24 5; then
    echo "::error::Previous Container Apps client certificate mode did not recover after rollout failure."
    exit 1
  fi
}

# Workflow step: Deactivate zero-traffic candidates after failed rollout
step_deactivate-zero-traffic-candidates-after-failed-rollout() {
  source ops/deployment/containerapp.sh
  CLEANUP_FAILED=0
  ca_deactivate_candidate app "$APP_NAME" "$APP_CANDIDATE" "$APP_PREVIOUS" "$RG" || CLEANUP_FAILED=1
  ca_deactivate_candidate scanner "$SCANNER_NAME" "$SCANNER_CANDIDATE" "$SCANNER_PREVIOUS" "$RG" || CLEANUP_FAILED=1
  ca_deactivate_candidate egress-proxy "$EGRESS_NAME" "$EGRESS_CANDIDATE" "$EGRESS_PREVIOUS" "$RG" || CLEANUP_FAILED=1
  exit "$CLEANUP_FAILED"
}

step="${1:-}"
case "$step" in
  deploy-app-container-app) step_deploy-app-container-app ;;
  deploy-scanner-container-app) step_deploy-scanner-container-app ;;
  deploy-egress-proxy-container-app) step_deploy-egress-proxy-container-app ;;
  smoke-candidate-revisions) step_smoke-candidate-revisions ;;
  verify-worker-queues-are-empty-before-traffic-promotion) step_verify-worker-queues-are-empty-before-traffic-promotion ;;
  promote-healthy-candidate-revisions) step_promote-healthy-candidate-revisions ;;
  smoke-production-traffic) step_smoke-production-traffic ;;
  deactivate-superseded-container-app-revisions) step_deactivate-superseded-container-app-revisions ;;
  remove-excess-scanner-secrets) step_remove-excess-scanner-secrets ;;
  promote-verified-worker-digest-on-vm) step_promote-verified-worker-digest-on-vm ;;
  roll-back-production-traffic-on-health-failure) step_roll-back-production-traffic-on-health-failure ;;
  restore-prior-ingress-mode-after-failed-rollout) step_restore-prior-ingress-mode-after-failed-rollout ;;
  deactivate-zero-traffic-candidates-after-failed-rollout) step_deactivate-zero-traffic-candidates-after-failed-rollout ;;
  *) echo "Unknown deploy Azure rollout step: ${step}" >&2; exit 2 ;;
esac
