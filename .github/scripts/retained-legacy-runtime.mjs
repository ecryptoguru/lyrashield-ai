// A narrow web/scanner release against the retained production worker. This is
// neither new-engine qualification nor authority to change the worker or relay.
import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

export const LEGACY_PRODUCT = "b03f0bbe2b42f3a49e24e103655187372ba0a5f6"
export const LEGACY_ENGINE = "3001517530300ca5f602536bfadcbd3c95ad3039"
const SHA = /^[a-f0-9]{40}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/
const HASH = /^[a-f0-9]{64}$/
const repository = "ghcr.io/ecryptoguru/lyrashield-ai"

export function parseRetainedApproval(raw, source) {
  const approval = JSON.parse(raw)
  const fields = [
    "schema",
    "sourceSha",
    "reviewedSourceSha",
    "workerDigest",
    "workerSourceSha",
    "engineRevision",
    "sandboxImage",
    "workerEnvironmentSha256",
    "egressDigest",
    "egressSourceSha",
  ]
  if (
    !approval ||
    Array.isArray(approval) ||
    Object.keys(approval).sort().join() !== fields.sort().join() ||
    approval.schema !== "lyrashield-retained-worker/1" ||
    !SHA.test(source ?? "") ||
    approval.sourceSha !== source ||
    approval.reviewedSourceSha !== source ||
    approval.workerSourceSha !== LEGACY_PRODUCT ||
    approval.engineRevision !== LEGACY_ENGINE ||
    approval.egressSourceSha !== LEGACY_PRODUCT ||
    !DIGEST.test(approval.workerDigest ?? "") ||
    !DIGEST.test(approval.egressDigest ?? "") ||
    !HASH.test(approval.workerEnvironmentSha256 ?? "") ||
    !/^ghcr\.io\/ecryptoguru\/lyrashield-sandbox@sha256:[a-f0-9]{64}$/.test(
      approval.sandboxImage ?? ""
    )
  )
    throw new Error("Protected retained-worker approval is absent or mismatched")
  return approval
}

export function assertRetainedMode(env, approval) {
  if (
    env.GITHUB_REF !== "refs/heads/main" ||
    env.DEPLOY_SHA !== approval.sourceSha ||
    env.RETAINED_WORKER_SOURCE !== approval.workerSourceSha ||
    env.WORKER_DIGEST !== approval.workerDigest ||
    env.ENGINE_REVISION !== approval.engineRevision ||
    env.EGRESS_PROXY_DIGEST !== approval.egressDigest ||
    env.WORKER_IMAGE !== `${repository}/lyrashield-worker` ||
    env.EGRESS_PROXY_IMAGE !== `${repository}/lyrashield-egress-proxy` ||
    env.WEBHOOK_CLAIMS_CUTOVER === "true" ||
    env.WEBHOOK_CUTOVER_RECOVERY === "true" ||
    env.V26_CUTOVER === "true" ||
    env.PAIRED_QUALIFIED_RELEASE_SHA256 ||
    (env.LYRASHIELD_AI_RESULT_CACHE_MODE ?? "off") !== "off"
  )
    throw new Error(
      "Retained-worker release cannot enter maintenance, qualification or worker replacement"
    )
}

function execute(file, args) {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180000,
      maxBuffer: 1024 * 1024,
    })
  } catch {
    throw new Error("Retained runtime authoritative operation failed")
  }
}
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"

export function assertRetainedSource(source, run = execute) {
  // Protected approval binds a fresh compatibility review to this exact source.
  // Source qualification/current-main checks are also required by the caller.
  if (!SHA.test(source ?? "") || run("git", ["rev-parse", "HEAD"]).trim() !== source)
    throw new Error("Retained compatibility review does not match the checkout")
}

export function retainedWorkerProbe(approval, redisHash, requireEmptyQueues = true) {
  if (!HASH.test(redisHash) || typeof requireEmptyQueues !== "boolean")
    throw new Error("Retained worker probe configuration unavailable")
  const expected = Buffer.from(JSON.stringify({ ...approval, redisHash })).toString("base64")
  const code = `
    const {createHash}=await import("node:crypto");
    const hash=value=>createHash("sha256").update(value).digest("hex");
    const expected=JSON.parse(Buffer.from(process.argv[1],"base64").toString());
    if(process.env.LYRASHIELD_PRODUCT_REVISION!==expected.workerSourceSha ||
       process.env.LYRASHIELD_WORKER_IMAGE_DIGEST!==expected.workerDigest ||
       process.env.LYRASHIELD_ENGINE_REVISION!==expected.engineRevision ||
       process.env.LYRASHIELD_IMAGE!==expected.sandboxImage || hash(process.env.REDIS_URL)!==expected.redisHash)
      throw Error("Retained worker identity differs");
    const {closeRedis,assertScanWorkerAvailable}=await import("@lyrashield/integrations");
    try {
      await assertScanWorkerAvailable();
      ${
        requireEmptyQueues
          ? `const {getSystemPrisma}=await import("@lyrashield/db");
      const {getScanQueue,getWebhookTrackRetryQueue}=await import("@lyrashield/integrations");
      const prisma=getSystemPrisma(),scan=getScanQueue(),webhook=getWebhookTrackRetryQueue();
      try {
      const counts=await Promise.all([prisma.scan.count({where:{status:{in:["QUEUED","PREFLIGHT","RUNNING","VERIFYING","REQUIRES_APPROVAL"]}}}),
        scan.getJobCounts("wait","active","delayed","prioritized","paused","waiting-children"),
        webhook.getJobCounts("wait","active","delayed","prioritized","paused","waiting-children")]);
      if(counts[0]!==0 || counts.slice(1).some(row=>Object.keys(row).sort().join()!==["wait","active","delayed","prioritized","paused","waiting-children"].sort().join() || Object.values(row).some(value=>value!==0))) throw Error("Retained queues are not empty");
      } finally {await Promise.allSettled([prisma.$disconnect(),scan.close(),webhook.close()]);}`
          : ""
      }
    } finally {await Promise.allSettled([closeRedis()]);}
  `
  const inspect = `const {createHash}=require("node:crypto");const row=JSON.parse(require("node:fs").readFileSync(0,"utf8"))[0];const a=JSON.parse(Buffer.from(process.argv[1],"base64").toString());if(!row.State?.Running||row.State?.Health?.Status!=="healthy"||!["${repository}/lyrashield-worker@"+a.workerDigest,"${repository}/lyrashield-worker:"+a.workerSourceSha+"@"+a.workerDigest].includes(row.Config.Image)||row.Config.Labels?.["org.opencontainers.image.revision"]!==a.workerSourceSha||row.Config.Labels?.["io.lyrashield.engine.revision"]!==a.engineRevision||row.Config.Labels?.["io.lyrashield.accounting.protocol"]!=="reservations/2"||createHash("sha256").update(JSON.stringify([...row.Config.Env].sort())).digest("hex")!==a.workerEnvironmentSha256)process.exit(1)`
  return `set -eu; systemctl is-active --quiet lyrashield-worker.service; docker inspect lyrashield-worker | docker exec -i lyrashield-worker node -e ${quote(inspect)} ${quote(expected)}; docker exec -w /app/apps/worker lyrashield-worker node --import tsx --input-type=module -e ${quote(code)} ${quote(expected)}`
}

export function assertProbeAcknowledgement(result) {
  const message = result?.value?.[0]?.message
  if (
    !Array.isArray(result?.value) ||
    result.value.length !== 1 ||
    typeof message !== "string" ||
    message.split(/\r?\n/).filter((line) => line === "RETAINED_WORKER_READY").length !== 1 ||
    /\[stderr\]\s*\S/.test(message)
  )
    throw new Error("Retained worker readback unavailable")
}

export async function readRetainedRuntime(
  approval,
  env,
  run = execute,
  { requireEmptyQueues = true } = {}
) {
  assertRetainedMode(env, approval)
  assertRetainedSource(approval.sourceSha, run)
  const { createHash } = await import("node:crypto")
  if (
    !env.BULLMQ_REDIS_URL ||
    !/^[A-Za-z0-9-]+$/.test(env.RG ?? "") ||
    !/^[A-Za-z0-9-]+$/.test(env.WORKER_VM_NAME ?? "") ||
    !/^[A-Za-z0-9-]+$/.test(env.RETAINED_EGRESS_NAME ?? "")
  )
    throw new Error("Retained runtime configuration unavailable")
  const az = (args) => JSON.parse(run("az", [...args, "--only-show-errors", "--output", "json"]))
  const relay = az([
    "containerapp",
    "show",
    "--name",
    env.RETAINED_EGRESS_NAME,
    "--resource-group",
    env.RG,
  ])
  const traffic = relay.properties?.configuration?.ingress?.traffic
  const active = az([
    "containerapp",
    "revision",
    "list",
    "--name",
    env.RETAINED_EGRESS_NAME,
    "--resource-group",
    env.RG,
  ])
  const current = traffic?.filter((row) => row.weight === 100 && row.revisionName)
  if (current?.length !== 1 || traffic.some((row) => row !== current[0] && row.weight !== 0))
    throw new Error("Retained relay traffic ambiguous")
  const revision = active.filter((row) => row.name === current[0].revisionName)
  if (
    revision.length !== 1 ||
    revision[0].properties?.active !== true ||
    revision[0].properties?.healthState !== "Healthy" ||
    revision[0].properties?.template?.containers?.length !== 1 ||
    revision[0].properties.template.containers[0].image !==
      `${repository}/lyrashield-egress-proxy:${approval.egressSourceSha}@${approval.egressDigest}`
  )
    throw new Error("Retained relay identity or health differs")
  const fqdn = relay.properties.configuration.ingress.fqdn
  if (!/^[a-z0-9.-]+\.azurecontainerapps\.io$/.test(fqdn ?? ""))
    throw new Error("Retained relay endpoint unavailable")
  const probe =
    retainedWorkerProbe(
      approval,
      createHash("sha256").update(env.BULLMQ_REDIS_URL).digest("hex"),
      requireEmptyQueues
    ) +
    `; status=$(curl --disable --fail --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' ${quote(`https://${fqdn}/health`)}); [ "$status" = 200 ]; echo RETAINED_WORKER_READY`
  const result = az([
    "vm",
    "run-command",
    "invoke",
    "--name",
    env.WORKER_VM_NAME,
    "--resource-group",
    env.RG,
    "--command-id",
    "RunShellScript",
    "--scripts",
    probe,
  ])
  assertProbeAcknowledgement(result)
}

async function main() {
  const env = process.env
  const approval = parseRetainedApproval(env.RETAINED_WORKER_APPROVAL, env.DEPLOY_SHA)
  assertRetainedSource(approval.sourceSha)
  if (process.argv[2] === "approve") {
    for (const [key, value] of Object.entries(approval)) {
      // GitHub supplies the per-step output file, never an approval field.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`)
    }
  } else if (process.argv[2] === "readback") await readRetainedRuntime(approval, env)
  else if (process.argv[2] === "readback-identity")
    await readRetainedRuntime(approval, env, execute, { requireEmptyQueues: false })
  else throw new Error("Unknown retained release action")
  console.log("Retained legacy runtime check passed")
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("Retained legacy runtime check failed; release remains blocked")
    process.exitCode = 1
  })
}
