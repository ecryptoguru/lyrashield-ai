import { access, open, rename, unlink } from "node:fs/promises"
import { constants } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"

const execFileAsync = promisify(execFile)
const ORIGIN = "https://app.lyrashieldai.com"
const idPattern = /^[A-Za-z0-9_-]{1,128}$/
const shaPattern = /^[a-f0-9]{40}$/
const digestPattern = /^sha256:[a-f0-9]{64}$/
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function readCanaryConfig(env) {
  const config = {
    key: env.LYRASHIELD_CANARY_API_KEY,
    workspaceId: env.LYRASHIELD_CANARY_WORKSPACE_ID,
    targetId: env.LYRASHIELD_CANARY_TARGET_ID,
    targetUrl: env.LYRASHIELD_CANARY_TARGET_URL,
    runId: env.LYRASHIELD_CANARY_RUN_ID,
    productRevision: env.LYRASHIELD_CANARY_PRODUCT_REVISION,
    engineRevision: env.LYRASHIELD_CANARY_ENGINE_REVISION,
    workerDigest: env.LYRASHIELD_CANARY_WORKER_DIGEST,
    proofCommand: env.LYRASHIELD_CANARY_PROOF_COMMAND,
  }
  if (!/^lsk_[A-Za-z0-9_-]+$/.test(config.key ?? "")) throw new Error("CANARY_API_KEY_MISSING")
  for (const value of [config.workspaceId, config.targetId]) {
    if (!idPattern.test(value ?? "")) throw new Error("CANARY_IDENTITY_INVALID")
  }
  if (!/^[0-9]{1,20}$/.test(config.runId ?? "")) throw new Error("CANARY_IDENTITY_INVALID")
  if (
    !shaPattern.test(config.productRevision ?? "") ||
    !shaPattern.test(config.engineRevision ?? "") ||
    !digestPattern.test(config.workerDigest ?? "")
  )
    throw new Error("CANARY_RELEASE_IDENTITY_INVALID")
  let url
  try {
    url = new URL(config.targetUrl)
  } catch {
    throw new Error("CANARY_TARGET_URL_INVALID")
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== config.targetUrl
  )
    throw new Error("CANARY_TARGET_URL_INVALID")
  if (!config.proofCommand?.startsWith("/")) throw new Error("CANARY_PROOF_COMMAND_MISSING")
  return config
}

async function request(config, path, options = {}, fetchImpl = fetch) {
  let response
  try {
    response = await fetchImpl(`${ORIGIN}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${config.key}`, ...options.headers },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new Error("CANARY_API_UNAVAILABLE_OR_OUTCOME_UNKNOWN")
  }
  let json
  try {
    json = await response.json()
  } catch {
    throw new Error("CANARY_API_RESPONSE_INVALID")
  }
  if (!response.ok || json?.success !== true || !json.data || typeof json.data !== "object")
    throw new Error("CANARY_API_REFUSED_OR_OUTCOME_UNKNOWN")
  return json.data
}

export async function preflight(config, fetchImpl = fetch) {
  await access(config.proofCommand, constants.X_OK)
  let cursor = null
  const seen = new Set()
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ workspaceId: config.workspaceId, limit: "100" })
    if (cursor) query.set("cursor", cursor)
    const data = await request(config, `/api/v1/targets?${query}`, {}, fetchImpl)
    if (!Array.isArray(data.items)) throw new Error("CANARY_TARGET_LIST_INVALID")
    const found = data.items.filter((item) => item.id === config.targetId)
    if (found.length > 1) throw new Error("CANARY_TARGET_AMBIGUOUS")
    if (found.length === 1) {
      const target = found[0]
      if (
        target.type !== "WEB_APP" ||
        target.status !== "active" ||
        target.url !== config.targetUrl
      )
        throw new Error("CANARY_TARGET_MISMATCH")
      const eligibility = new URLSearchParams({
        workspaceId: config.workspaceId,
        targetId: config.targetId,
        goal: "TEST_APP",
        mode: "SAFE",
      })
      const admission = await request(
        config,
        `/api/v1/scans/eligibility?${eligibility}`,
        {},
        fetchImpl
      )
      if (admission.allowed !== true) throw new Error("CANARY_ELIGIBILITY_DENIED")
      return
    }
    if (!data.nextCursor) break
    if (!idPattern.test(data.nextCursor) || seen.has(data.nextCursor))
      throw new Error("CANARY_TARGET_CURSOR_INVALID")
    cursor = data.nextCursor
    seen.add(cursor)
  }
  throw new Error("CANARY_TARGET_NOT_FOUND")
}

async function defaultProof(config, payload) {
  const env = { ...process.env }
  delete env.LYRASHIELD_CANARY_API_KEY
  const { stdout } = await execFileAsync(
    config.proofCommand,
    [Buffer.from(JSON.stringify(payload)).toString("base64url")],
    {
      env,
      timeout: 90_000,
      maxBuffer: 16_384,
      encoding: "utf8",
    }
  )
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error("CANARY_PROOF_INVALID")
  }
}

export async function runCanary(
  config,
  { fetchImpl = fetch, proof = defaultProof, wait = sleep, now = Date.now } = {}
) {
  await preflight(config, fetchImpl)
  const idempotencyKey = `cold-canary:${config.runId}:${config.productRevision}`
  const body = {
    workspaceId: config.workspaceId,
    targetId: config.targetId,
    goal: "TEST_APP",
    mode: "SAFE",
  }
  // Exactly one POST per invocation. An unknown result fails; no automatic retry.
  const created = await request(
    config,
    "/api/v1/scans",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body),
    },
    fetchImpl
  )
  if (!idPattern.test(created.id ?? "") || !idPattern.test(created.operationId ?? ""))
    throw new Error("CANARY_CREATE_RECEIPT_INVALID")
  const deadline = now() + 15 * 60_000
  let status
  while (now() < deadline) {
    const query = new URLSearchParams({ workspaceId: config.workspaceId })
    status = await request(
      config,
      `/api/v1/scans/${encodeURIComponent(created.id)}?${query}`,
      {},
      fetchImpl
    )
    if (status.id !== created.id || status.workspaceId !== config.workspaceId)
      throw new Error("CANARY_SCAN_IDENTITY_MISMATCH")
    if (status.status === "COMPLETED") break
    if (!["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING"].includes(status.status))
      throw new Error("CANARY_SCAN_NOT_COMPLETED")
    await wait(5000)
  }
  const checksum = status?.resultManifest?.checksum
  if (status?.status !== "COMPLETED" || !/^[a-f0-9]{64}$/.test(checksum ?? ""))
    throw new Error("CANARY_SCAN_TIMEOUT_OR_MANIFEST_MISSING")
  const payload = {
    version: 1,
    workspaceId: config.workspaceId,
    targetId: config.targetId,
    targetUrl: config.targetUrl,
    scanId: created.id,
    operationId: created.operationId,
    idempotencyKey,
    checksum,
    productRevision: config.productRevision,
    engineRevision: config.engineRevision,
    workerDigest: config.workerDigest,
  }
  // The terminal status can become visible just before accounting releases the
  // reservation. Read-only proof retries never create or requeue a scan.
  let receipt
  for (let i = 0; i < 12; i++) {
    try {
      receipt = await proof(config, payload)
      break
    } catch {
      if (i === 11) throw new Error("CANARY_PROOF_UNAVAILABLE")
      await wait(5000)
    }
  }
  if (
    receipt?.version !== 1 ||
    receipt?.result !== "MATCH" ||
    receipt.scanId !== payload.scanId ||
    receipt.operationId !== payload.operationId ||
    receipt.checksum !== checksum ||
    receipt.productRevision !== payload.productRevision ||
    receipt.engineRevision !== payload.engineRevision ||
    receipt.workerDigest !== payload.workerDigest
  )
    throw new Error("CANARY_PROOF_MISMATCH")
  return { ...receipt, workspaceId: payload.workspaceId, proofPayload: payload }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = readCanaryConfig(process.env)
    if (process.argv.length === 3 && process.argv[2] === "--preflight") {
      await preflight(config)
      console.log("CANARY_PREFLIGHT_MATCH")
    } else if (process.argv.length === 2) {
      if (!process.env.RUNNER_TEMP?.startsWith("/"))
        throw new Error("CANARY_RECEIPT_DIRECTORY_MISSING")
      const receipt = await runCanary(config)
      const destination = `${process.env.RUNNER_TEMP}/cold-unpaid-canary.json`
      const temporary = `${destination}.${process.pid}.tmp`
      try {
        const file = await open(temporary, "wx", 0o600)
        try {
          await file.writeFile(`${JSON.stringify(receipt)}\n`)
          await file.sync()
        } finally {
          await file.close()
        }
        await rename(temporary, destination)
      } catch (error) {
        await unlink(temporary).catch(() => {})
        throw error
      }
      console.log(JSON.stringify({ ...receipt, proofPayload: undefined }))
    } else throw new Error("CANARY_ARGUMENT_INVALID")
  } catch (error) {
    // Do not print provider responses, command stderr or credentials.
    console.error(
      error instanceof Error && /^CANARY_[A-Z_]+$/.test(error.message)
        ? error.message
        : "CANARY_FAILED"
    )
    process.exitCode = 1
  }
}
