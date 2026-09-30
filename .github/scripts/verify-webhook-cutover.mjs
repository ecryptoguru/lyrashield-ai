import { execFileSync } from "node:child_process"

const protocol = "durable-claims/1"
const fail = (message) => {
  throw new Error(
    `${message}. First webhook cutover requires the approved maintenance runbook; normal release cannot bootstrap or bypass it.`
  )
}
const run = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", timeout: 180_000, maxBuffer: 1024 * 1024 }).trim()
const json = (command, args) => JSON.parse(run(command, args))
const sha = /^[a-f0-9]{40}$/
const digest = /@sha256:[a-f0-9]{64}$/
const group = process.env.AZURE_RESOURCE_GROUP
const worker = process.env.AZURE_WORKER_VM_NAME
if (!process.env.AZURE_APP_CONTAINER_APP_NAME) fail("Missing app writer baseline")
if (!group || !worker) fail("Missing resource group or worker VM")

const vault = process.env.AZURE_KEY_VAULT_NAME
const registryUser = process.env.GHCR_USERNAME
if (!vault || !registryUser) fail("Missing registry provenance credentials")
const registryToken = run("az", [
  "keyvault",
  "secret",
  "show",
  "--vault-name",
  vault,
  "--name",
  "ghcr-token",
  "--query",
  "value",
  "--output",
  "tsv",
])
if (!registryToken) fail("Registry provenance credential unavailable")
execFileSync("docker", ["login", "ghcr.io", "--username", registryUser, "--password-stdin"], {
  input: registryToken,
  encoding: "utf8",
  timeout: 30_000,
  stdio: ["pipe", "pipe", "pipe"],
})

for (const name of [
  process.env.AZURE_APP_CONTAINER_APP_NAME,
  process.env.AZURE_SCANNER_CONTAINER_APP_NAME,
].filter(Boolean)) {
  const revisions = json("az", [
    "containerapp",
    "revision",
    "list",
    "--name",
    name,
    "--resource-group",
    group,
    "--output",
    "json",
  ])
  const active = revisions.filter((revision) => revision.properties?.active === true)
  if (!active.length) fail(`${name} has no active compatible writer baseline`)
  for (const revision of active) {
    const containers = revision.properties?.template?.containers
    if (!Array.isArray(containers) || containers.length !== 1)
      fail("Unexpected writer container topology")
    const container = containers[0]
    const identity =
      container.env?.find((entry) => entry.name === "LYRASHIELD_PRODUCT_REVISION")?.value ??
      container.image?.match(/:([a-f0-9]{40})@sha256:/)?.[1]
    if (
      !sha.test(identity ?? "") ||
      !digest.test(container.image ?? "") ||
      !container.image.includes(`:${identity}@`)
    )
      fail("Writer image and source identity mismatch")
    const imageConfig = json("docker", [
      "buildx",
      "imagetools",
      "inspect",
      container.image,
      "--format",
      "{{json .Image}}",
    ])
    const configs = imageConfig?.config ? [imageConfig] : Object.values(imageConfig ?? {})
    if (
      !configs.length ||
      configs.some(
        (config) => config?.config?.Labels?.["org.opencontainers.image.revision"] !== identity
      )
    )
      fail("Writer OCI revision does not match source identity")
    run("git", ["fetch", "--no-tags", "origin", identity])
    const source = run("git", ["show", `${identity}:packages/billing/src/webhook-tracks.ts`])
    if (!source.includes(`export const WEBHOOK_TRACK_CLAIM_PROTOCOL = "${protocol}"`))
      fail(`${name} has an incompatible active writer revision`)
  }
}

// Inspect the running container only; no one-shot job, restart, queue write or secret read.
const code =
  'const billing=await import("@lyrashield/billing"); const {getSystemPrisma}=await import("@lyrashield/db"); const prisma=getSystemPrisma(); try { const rows=await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`, "20260930120000_webhook_track_claims"); console.log(JSON.stringify({protocol:billing.WEBHOOK_TRACK_CLAIM_PROTOCOL,product:process.env.LYRASHIELD_PRODUCT_REVISION,digest:process.env.LYRASHIELD_WORKER_IMAGE_DIGEST,engine:process.env.LYRASHIELD_ENGINE_REVISION,migrated:rows[0]?.count===1})); } finally { await prisma.$disconnect(); }'
// Constant script text; no user-controlled shell interpolation.
const script = `set -eu
systemctl is-active --quiet lyrashield-worker.service
test "$(docker inspect --format '{{.State.Running}}' lyrashield-worker)" = true
printf 'WORKER_ROLLBACK_IMAGE=%s
' "$(sed -n 's/^LYRASHIELD_WORKER_IMAGE=//p' /etc/lyrashield/worker-runtime.conf)"
printf 'WORKER_IMAGE=%s
' "$(docker inspect --format '{{.Config.Image}}' lyrashield-worker)"
printf 'WORKER_PRODUCT=%s
' "$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' lyrashield-worker)"
printf 'WORKER_ENGINE=%s
' "$(docker inspect --format '{{index .Config.Labels "io.lyrashield.engine.revision"}}' lyrashield-worker)"
docker exec -w /app/apps/worker lyrashield-worker node --import tsx --input-type=module -e '${code.replaceAll("'", "'\''")}'`
const response = run("az", [
  "vm",
  "run-command",
  "invoke",
  "--resource-group",
  group,
  "--name",
  worker,
  "--command-id",
  "RunShellScript",
  "--scripts",
  script,
  "--query",
  "value[0].message",
  "--output",
  "tsv",
])
const lines = response.split("\n").filter((line) => line.startsWith('{"protocol":'))
if (lines.length !== 1) fail("Worker compatibility readback unavailable")
const state = JSON.parse(lines[0])
const readback = (key) =>
  response
    .split("\n")
    .find((line) => line.startsWith(`${key}=`))
    ?.slice(key.length + 1)
if (
  readback("WORKER_ROLLBACK_IMAGE") !== readback("WORKER_IMAGE") ||
  !readback("WORKER_IMAGE")?.endsWith(`@${state.digest}`) ||
  readback("WORKER_PRODUCT") !== state.product ||
  readback("WORKER_ENGINE") !== state.engine
)
  fail("Worker runtime and image provenance mismatch")
if (
  state.protocol !== protocol ||
  !state.migrated ||
  !sha.test(state.product ?? "") ||
  !sha.test(state.engine ?? "") ||
  !/^sha256:[a-f0-9]{64}$/.test(state.digest ?? "")
)
  fail("Worker claims protocol, migration or immutable provenance unavailable")
console.log(
  "Webhook cutover baseline verified: active writer revisions and live worker are claim-compatible; additive migration completed."
)
