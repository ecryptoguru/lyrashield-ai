import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

const runtime = readFileSync(".github/workflows/deploy-azure-runtime.yml", "utf8")
const caller = readFileSync(".github/workflows/deploy-azure.yml", "utf8")
const rollout = readFileSync(".github/scripts/deploy-azure-rollout.sh", "utf8")
const containerAppHelper = path.resolve("ops/deployment/containerapp.sh")

const functionBody = (script, slug) => {
  const marker = `step_${slug}() {\n`
  const start = script.indexOf(marker)
  assert.notEqual(start, -1, `expected the ${slug} workflow step function`)
  const end = script.indexOf("\n}\n", start + marker.length)
  assert.notEqual(end, -1, `expected the ${slug} workflow step function to close`)
  return script.slice(start + marker.length, end)
}

const stepYaml = (name) => {
  const start = runtime.indexOf(`      - name: ${name}\n`)
  assert.notEqual(start, -1, `expected workflow step ${name}`)
  const end = runtime.indexOf("\n      - name:", start + 1)
  return runtime.slice(start, end < 0 ? runtime.length : end)
}

const normalizedIf = (name) => {
  const step = stepYaml(name)
  const oneLine = step.match(/^        if: (.*)$/m)
  if (oneLine && oneLine[1].trim() !== ">") return oneLine[1].trim().replace(/\s+/g, " ")
  const folded = step.match(/^        if: >\n([\s\S]*?)(?=^        env:|^        run:)/m)
  assert.ok(folded, `expected an if condition on ${name}`)
  return folded[1].trim().replace(/\s+/g, " ")
}

test("scanner deployment binds the prepared digest-only web image to its exact source", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "lyra-scanner-source-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const azPath = path.join(directory, "az")
  const updateArgsPath = path.join(directory, "update-args")
  const outputPath = path.join(directory, "github-output")
  const source = "de92b93a2bef1c44e5837b15949c453f0d8a28c6"
  const image =
    "ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-web@sha256:e0e53a32c37b3bb84ce5832663411f59bbe542faa406c3517983c1a0b4385b9b"
  writeFileSync(
    azPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2" = "containerapp update" ]; then
  printf '%s\\n' "$@" > "$FAKE_AZ_UPDATE_ARGS"
elif [ "$1 $2" = "containerapp show" ]; then
  printf 'scanner-candidate\\n'
elif [ "$1 $2 $3" = "containerapp revision show" ]; then
  printf 'scanner-candidate.example.test\\n'
else
  exit 91
fi
`,
    { mode: 0o700 }
  )
  const env = {
    PATH: `${directory}${path.delimiter}${process.env.PATH}`,
    FAKE_AZ_UPDATE_ARGS: updateArgsPath,
    GITHUB_OUTPUT: outputPath,
    IMAGE: image,
    DEPLOY_SHA: source,
    AZURE_RESOURCE_GROUP: "fixture-rg",
    AZURE_SCANNER_CONTAINER_APP_NAME: "fixture-scanner",
    EMAIL_VERIFICATION_REQUIRED: "1",
    REQUIRE_EMAIL_VERIFICATION: "1",
    SCANNER_URL: "https://scanner.example.test",
    APP_URL: "https://app.example.test",
    MARKETING_URL: "https://example.test",
    PLATFORM_ADMIN_EMAILS: "operator@example.test",
    POLAR_BILLING_ADMISSION: "off",
    POLAR_LOCAL_BILLING_ADMISSION: "off",
    RAZORPAY_BILLING_ADMISSION: "off",
    RAZORPAY_LOCAL_BILLING_ADMISSION: "off",
  }
  execFileSync(
    "bash",
    [".github/scripts/deploy-azure-rollout.sh", "deploy-scanner-container-app"],
    {
      env,
      encoding: "utf8",
    }
  )
  const args = readFileSync(updateArgsPath, "utf8").trim().split("\n")
  assert.equal(args[args.indexOf("--image") + 1], image)
  assert.ok(args.includes(`LYRASHIELD_PRODUCT_REVISION=${source}`))
  assert.match(readFileSync(outputPath, "utf8"), /^revision=scanner-candidate$/m)
})

test("Azure caller passes reusable-workflow inputs through supported contexts", () => {
  const deploy = caller.slice(caller.indexOf("\n  deploy:"))
  const inputsStart = deploy.indexOf("\n    with:\n")
  const inputsEnd = deploy.indexOf("\n    secrets:", inputsStart)
  assert.notEqual(inputsStart, -1, "expected reusable runtime inputs")
  assert.notEqual(inputsEnd, -1, "expected reusable runtime secrets")

  const reusableInputs = deploy.slice(inputsStart, inputsEnd)
  assert.match(reusableInputs, /source_sha: \$\{\{ inputs\.source_sha \|\| github\.sha \}\}/)
  assert.match(
    reusableInputs,
    /engine_revision: \$\{\{ needs\.resolve-images\.outputs\.engine_revision \}\}/
  )
  assert.match(caller, /\[ "\$BUILD_RESULT" = success \] && \[ "\$PREPARED_RESULT" = skipped \]/)
  assert.match(caller, /BUILT_ENGINE_REVISION: \$\{\{ needs\.build\.outputs\.engine_revision \}\}/)
  assert.doesNotMatch(reusableInputs, /\$\{\{\s*env\./)
  assert.match(caller, /engine_revision: \$\{\{ steps\.meta\.outputs\.engine_revision \}\}/)
  assert.match(caller, /echo "engine_revision=\$\{\{ env\.ENGINE_REVISION \}\}"/)
})

test("Container Apps helpers preserve Azure call sequences and guarded failure behavior", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "lyra-ca-characterization-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const bin = path.join(directory, "bin")
  const calls = path.join(directory, "az-calls")
  const mode = path.join(directory, "client-cert-mode")
  mkdirSync(bin)
  writeFileSync(mode, "Ignore\n")
  writeFileSync(calls, "")
  writeFileSync(
    path.join(bin, "az"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_AZ_CALLS"
if [ "$1" = "containerapp" ] && [ "$2" = "show" ]; then
  case "$*" in
    *properties.latestRevisionName*) printf 'candidate-r\\n' ;;
    *"--query id"*) printf '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.App/containerApps/app\\n' ;;
    *) exit 1 ;;
  esac
elif [ "$1" = "containerapp" ] && [ "$2" = "revision" ] && [ "$3" = "show" ]; then
  case "$*" in
    *properties.fqdn*) printf 'candidate.example.test\\n' ;;
    *properties.active*) printf 'true\\n' ;;
    *) exit 1 ;;
  esac
elif [ "$1" = "rest" ] && [ "$2" = "--method" ] && [ "$3" = "get" ]; then
  cat "$FAKE_CLIENT_CERT_MODE"
elif [ "$1" = "rest" ] && [ "$2" = "--method" ] && [ "$3" = "patch" ]; then
  body=$(cat)
  printf 'patch-body:%s\\n' "$body" >> "$FAKE_AZ_CALLS"
  case "$body" in *Require*) printf 'Require\\n' > "$FAKE_CLIENT_CERT_MODE" ;; *) exit 1 ;; esac
elif [ "$1" = "containerapp" ] && [ "$2" = "ingress" ] && [ "$3" = "traffic" ] && [ "$4" = "show" ]; then
  case "$*" in
    *weight*100*) printf 'current-r\\n' ;;
    *"revisionName == 'current-r'"*) printf '100\\n' ;;
    *"revisionName == 'candidate-r'"*) printf '%s\\n' "\${FAKE_TRAFFIC_WEIGHT:-0}" ;;
    *"revisionName == 'old-r'"*) printf '0\\n' ;;
    *) printf '0\\n' ;;
  esac
elif [ "$1" = "containerapp" ] && [ "$2" = "ingress" ] && [ "$3" = "traffic" ] && [ "$4" = "set" ]; then
  :
elif [ "$1" = "containerapp" ] && [ "$2" = "revision" ] && [ "$3" = "activate" ]; then
  :
elif [ "$1" = "containerapp" ] && [ "$2" = "revision" ] && [ "$3" = "deactivate" ]; then
  :
elif [ "$1" = "containerapp" ] && [ "$2" = "revision" ] && [ "$3" = "list" ]; then
  case "$*" in *'length(@)'*) printf '2\\n' ;; *) printf 'current-r\\nrollback-r\\nold-r\\n' ;; esac
else
  echo "Unexpected fake az call: $*" >&2
  exit 91
fi
`,
    { mode: 0o700 }
  )
  writeFileSync(
    path.join(bin, "curl"),
    '#!/usr/bin/env bash\nprintf "curl\\n" >> "$FAKE_AZ_CALLS"\n',
    {
      mode: 0o700,
    }
  )
  writeFileSync(path.join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 })
  for (const name of ["az", "curl", "sleep"]) chmodSync(path.join(bin, name), 0o700)
  const script = `
set -euo pipefail
source "${containerAppHelper}"
candidate=$(ca_candidate app rg)
printf 'candidate=%s\\n' "$candidate"
resource_id=/subscriptions/sub/resourceGroups/rg/providers/Microsoft.App/containerApps/app
previous=$(ca_client_cert_mode_get "$resource_id")
ca_client_cert_mode_set "$resource_id" Require
ca_client_cert_mode_wait "$resource_id" Require 2 0
ca_set_traffic app candidate-r rg
ca_rollback_revision app app rollback-r https://ready.example.test rg 1
ca_deactivate_candidate app app candidate-r rollback-r rg
ca_deactivate_superseded app app current-r rollback-r rg
`
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_AZ_CALLS: calls,
    FAKE_CLIENT_CERT_MODE: mode,
  }
  const output = execFileSync("bash", ["-e", "-u", "-o", "pipefail", "-c", script], {
    encoding: "utf8",
    env,
  })
  assert.match(output, /candidate=candidate-r\tcandidate\.example\.test/)
  const commands = readFileSync(calls, "utf8").split("\n").filter(Boolean)
  const operation = (line) => {
    const parts = line.split(" ")
    if (parts[0] === "rest") return `rest ${parts[2]}`
    if (parts[0] !== "containerapp") return ""
    if (parts[1] === "show") return "containerapp show"
    if (parts[1] === "revision") return `containerapp revision ${parts[2]}`
    if (parts[1] === "ingress") return `containerapp ingress ${parts[2]} ${parts[3]}`
    return `containerapp ${parts[1]}`
  }
  assert.deepEqual(commands.map(operation).filter(Boolean), [
    "containerapp show",
    "containerapp revision show",
    "rest get",
    "rest patch",
    "rest get",
    "containerapp ingress traffic set",
    "containerapp revision activate",
    "containerapp ingress traffic set",
    "containerapp ingress traffic show",
    "containerapp revision show",
    "containerapp revision deactivate",
    "containerapp ingress traffic show",
    "containerapp ingress traffic show",
    "containerapp revision list",
    "containerapp ingress traffic show",
    "containerapp revision deactivate",
    "containerapp revision list",
  ])
  assert.match(readFileSync(calls, "utf8"), /patch-body:.*clientCertificateMode.*Require/)
  assert.equal(readFileSync(mode, "utf8").trim(), "Require")

  writeFileSync(calls, "")
  const failure = `source "${containerAppHelper}"; ca_deactivate_candidate app app candidate-r rollback-r rg`
  assert.throws(() =>
    execFileSync("bash", ["-e", "-u", "-o", "pipefail", "-c", failure], {
      env: { ...env, FAKE_TRAFFIC_WEIGHT: "50" },
      stdio: ["ignore", "pipe", "pipe"],
    })
  )
  const failedCalls = readFileSync(calls, "utf8")
  assert.match(failedCalls, /ingress traffic show/)
  assert.doesNotMatch(failedCalls, /revision deactivate/)
})

test("deployment step order, recovery conditions and app/scanner env key sets stay characterized", () => {
  const orderedSteps = [
    "Deploy app Container App",
    "Deploy scanner Container App",
    "Deploy egress-proxy Container App",
    "Smoke candidate revisions",
    "Verify worker queues are empty before traffic promotion",
    "Promote healthy candidate revisions",
    "Smoke production traffic",
    "Deactivate superseded Container App revisions",
    "Promote verified worker digest on VM",
    "Roll back production traffic on health failure",
    "Restore prior ingress mode after failed rollout",
    "Deactivate zero-traffic candidates after failed rollout",
  ]
  const positions = orderedSteps.map((name) => runtime.indexOf(`      - name: ${name}\n`))
  assert.ok(positions.every((position) => position >= 0))
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b)
  )

  assert.equal(
    normalizedIf("Deactivate superseded Container App revisions"),
    "steps.smoke-public.outcome == 'success' && inputs.held_recovery != true"
  )
  assert.equal(
    normalizedIf("Roll back production traffic on health failure"),
    "inputs.held_recovery != true && inputs.webhook_claims_cutover != true && failure() && (steps.promote.outcome == 'failure' || steps.smoke-public.outcome == 'failure' || steps.worker-vm.outcome == 'failure')"
  )
  assert.equal(
    normalizedIf("Restore prior ingress mode after failed rollout"),
    "inputs.held_recovery != true && inputs.webhook_claims_cutover != true && failure() && steps.deploy-app.outputs.previous_client_cert_mode != '' && (steps.deploy-app.outcome == 'failure' || steps.deploy-scanner.outcome == 'failure' || steps.deploy-egress-proxy.outcome == 'failure' || steps.smoke-candidates.outcome == 'failure' || steps.worker-preflight.outcome == 'failure' || steps.promote.outcome == 'failure' || steps.smoke-public.outcome == 'failure' || steps.worker-vm.outcome == 'failure')"
  )
  assert.equal(
    normalizedIf("Deactivate zero-traffic candidates after failed rollout"),
    "inputs.held_recovery != true && inputs.webhook_claims_cutover != true && failure() && (steps.deploy-app.outcome == 'failure' || steps.deploy-scanner.outcome == 'failure' || steps.deploy-egress-proxy.outcome == 'failure' || steps.smoke-candidates.outcome == 'failure' || steps.worker-preflight.outcome == 'failure' || steps.promote.outcome == 'failure' || steps.smoke-public.outcome == 'failure' || steps.worker-vm.outcome == 'failure')"
  )

  const app = functionBody(rollout, "deploy-app-container-app")
  const scanner = functionBody(rollout, "deploy-scanner-container-app")
  const envKeys = (body, flag) => {
    let section = body.split(`${flag} \\\n`)[1]?.split("--output none")[0]
    assert.ok(section, `expected ${flag} in deployment function`)
    if (flag === "--remove-env-vars") {
      section = section.split("--set-env-vars")[0]
      return section.match(/\b[A-Z][A-Z0-9_]*\b/g) ?? []
    }
    return [...section.matchAll(/"([A-Z][A-Z0-9_]*)=/g)].map((match) => match[1])
  }
  assert.deepEqual(envKeys(app, "--remove-env-vars"), [
    "LYRASHIELD_DEPLOYMENT_ENVIRONMENT",
    "BILLING_STAGING_ADMISSION",
    "BILLING_STAGING_ACCESS_TOKEN",
    "BILLING_STAGING_REGION",
    "MYRA_ALLOWED_EMAILS",
    "MYRA_MODEL_FAST",
    "MYRA_MODEL_DEEP",
    "MYRA_EMBED_MODEL",
    "MYRA_AZURE_OPENAI_DEPLOYMENT",
  ])
  assert.deepEqual(envKeys(scanner, "--remove-env-vars"), [
    "LYRASHIELD_DEPLOYMENT_ENVIRONMENT",
    "BILLING_STAGING_ADMISSION",
    "BILLING_STAGING_ACCESS_TOKEN",
    "BILLING_STAGING_REGION",
    "GITHUB_APP_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
    "MYRA_AZURE_OPENAI_DEPLOYMENT",
  ])
  assert.deepEqual(envKeys(app, "--set-env-vars"), [
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_MARKETING_URL",
    "BETTER_AUTH_URL",
    "PLATFORM_ADMIN_EMAILS",
    "IP_HASH_SALT",
    "LYRASHIELD_REQUIRE_EMAIL_VERIFICATION",
    "LYRASHIELD_PRODUCT_REVISION",
    "CLOUDFLARE_ORIGIN_MTLS",
    "CLOUDFLARE_AOP_CERT_SHA256",
    "DEPLOY_PROBE_CERT_SHA256",
    "POLAR_ENVIRONMENT",
    "POLAR_ACCESS_TOKEN",
    "POLAR_WEBHOOK_SECRET",
    "POLAR_PRODUCT_IDS",
    "POLAR_LOCAL_PRODUCT_IDS",
    "POLAR_BILLING_ADMISSION",
    "POLAR_LOCAL_BILLING_ADMISSION",
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "RAZORPAY_WEBHOOK_SECRET",
    "RAZORPAY_PLAN_IDS",
    "RAZORPAY_BILLING_ADMISSION",
    "RAZORPAY_LOCAL_BILLING_ADMISSION",
    "BILLING_CANARY_WORKSPACE_IDS",
    "REDIS_URL",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "LYRASHIELD_EVIDENCE_KEK",
    "LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF",
    "LYRASHIELD_EVIDENCE_KEK_KEYRING",
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "S3_REGION",
    "GITHUB_APP_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
    "MYRA_PUBLIC_ENABLED",
    "MYRA_DASHBOARD_ENABLED",
    "MYRA_OPERATOR_ENABLED",
    "MYRA_WRITES_ENABLED",
    "MYRA_PUBLIC_BOOKING_ENABLED",
    "MYRA_GENERATION_ENABLED",
    "MYRA_PROVIDER",
    "MYRA_CALENDAR_PROVIDER",
    "MYRA_AZURE_OPENAI_ENDPOINT",
    "MYRA_MODEL",
    "MYRA_MONTHLY_BUDGET_USD",
    "MYRA_GOOGLE_CLIENT_ID",
    "MYRA_GOOGLE_CALENDAR_ID",
    "MYRA_SUPPORT_NOTIFY_EMAIL",
  ])
  assert.deepEqual(envKeys(scanner, "--set-env-vars"), [
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_MARKETING_URL",
    "BETTER_AUTH_URL",
    "PLATFORM_ADMIN_EMAILS",
    "IP_HASH_SALT",
    "LYRASHIELD_REQUIRE_EMAIL_VERIFICATION",
    "LYRASHIELD_PRODUCT_REVISION",
    "POLAR_BILLING_ADMISSION",
    "POLAR_LOCAL_BILLING_ADMISSION",
    "RAZORPAY_BILLING_ADMISSION",
    "RAZORPAY_LOCAL_BILLING_ADMISSION",
    "BILLING_CANARY_WORKSPACE_IDS",
    "CLOUDFLARE_ORIGIN_MTLS",
    "CLOUDFLARE_AOP_CERT_SHA256",
    "DEPLOY_PROBE_CERT_SHA256",
    "REDIS_URL",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
  ])
  assert.doesNotMatch(scanner, /LYRASHIELD_AI_(?:RESULT_CACHE|CACHE_)/)

  for (const file of [
    ".github/workflows/deploy-azure.yml",
    ".github/workflows/deploy-azure-runtime.yml",
    ".github/scripts/deploy-azure-preflight.sh",
    ".github/scripts/deploy-azure-rollout.sh",
    "ops/deployment/containerapp.sh",
  ]) {
    const lineCount = readFileSync(file, "utf8").split("\n").length - 1
    // The separate held-recovery branch adds guarded steps to the reusable
    // runtime; preserve the original budget for every other deploy file.
    const limit = file === ".github/workflows/deploy-azure-runtime.yml" ? 950 : 900
    assert.ok(lineCount < limit, `${file} has ${lineCount} lines; expected fewer than ${limit}`)
  }

  const appDeploy = stepYaml("Deploy app Container App")
  for (const secret of [
    "LYRASHIELD_GITHUB_APP_CLIENT_ID",
    "LYRASHIELD_GITHUB_APP_CLIENT_SECRET",
    "MYRA_AZURE_OPENAI_API_KEY",
    "TURNSTILE_SECRET_KEY",
    "MYRA_GOOGLE_CLIENT_SECRET",
    "MYRA_GOOGLE_REFRESH_TOKEN",
  ]) {
    assert.doesNotMatch(
      appDeploy,
      new RegExp(`^[ \\t]+[A-Z0-9_]+: \\$\\{\\{ secrets\\.${secret} \\}\\}`, "m")
    )
    assert.match(runtime, new RegExp(`secrets\\.${secret} != ''`))
  }
})

test("scanner update never binds GitHub App credentials", () => {
  const scanner = functionBody(rollout, "deploy-scanner-container-app")
  const update = scanner.split("--set-env-vars")[1]?.split("--output none")[0]
  assert.ok(update)
  assert.doesNotMatch(
    update,
    /GITHUB_APP_ID|GITHUB_APP_SLUG|GITHUB_APP_PRIVATE_KEY|GITHUB_WEBHOOK_SECRET|GITHUB_APP_CLIENT_ID|GITHUB_APP_CLIENT_SECRET/
  )
  assert.match(scanner, /--remove-env-vars[\s\S]*GITHUB_APP_PRIVATE_KEY/)
})

// Reusable workflows cannot regain permissions removed by a caller job.
// A missing actions grant stops the entire release before any job starts.
test("release callers preserve read access through the nested maintenance workflow", () => {
  const release = readFileSync(".github/workflows/release-production.yml", "utf8")
  for (const [workflow, job] of [
    [release, "deploy-azure"],
    [caller, "deploy"],
    [runtime, "deploy"],
  ]) {
    const section = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [\w-]+:/)[0]
    assert.ok(section, `expected ${job} job`)
    const permissions = section.match(/^    permissions:\n((?:      .*\n)+)/m)?.[1]
    assert.match(permissions || "", /^      actions: read$/m, `${job} must preserve actions read`)
    assert.doesNotMatch(permissions, /^      actions: write$/m)
  }
})
