/* eslint-disable security/detect-non-literal-fs-filename -- Exact protected public artifacts and a fixed root socket; no caller-selected paths. */
import { createHash, createPublicKey } from "node:crypto"
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs"
import { createConnection } from "node:net"
import { Pool } from "pg"
import {
  canonicalJson,
  observeInstalledExecutionAuthority,
  requireCurrentPreparationDelegation,
  sha256Hex,
} from "@lyrashield/runtime-control"
import { createTrustedPreparationCompiler } from "@lyrashield/db/src/trusted-preparation-compiler"
import {
  requirePreparationExecutionContext,
  trustedPreparationHostPolicySchema,
} from "@lyrashield/db/src/trusted-preparation-proof"
import { scanDispatchWorkerReceiptCredential } from "@lyrashield/db/src/scan-dispatch-worker-assignment"
import type { ScanPreparationCompiler } from "@lyrashield/db/src/scan-dispatch-command-descriptor"

const ROOT = "/opt/lyrashield-runtime"
const SOCKET = `${ROOT}/preparation.sock`
const POLICY = `${ROOT}/preparation-host-policy.json`
const PUBLIC = `${ROOT}/preparation-public-key.pem`
const MAXIMUM = 128 * 1024
export interface InstalledPreparationAuthority {
  compiler: ScanPreparationCompiler
  stageOperation(operationId: string): Promise<void>
}

function protectedParent() {
  if (process.platform !== "linux" || !process.getuid?.() || process.getgid?.() === undefined)
    throw new Error("Preparation host unavailable")
  for (const path of ["/opt", ROOT]) {
    const info = lstatSync(path)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022)
      throw new Error("Preparation host unavailable")
  }
}

function readPublic(path: string): string {
  protectedParent()
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
  try {
    const info = fstatSync(descriptor)
    if (
      !info.isFile() ||
      info.uid !== 0 ||
      info.gid !== process.getgid?.() ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o440 ||
      info.size > 65536
    )
      throw new Error("Preparation public artifact unavailable")
    const raw = readFileSync(descriptor)
    const after = fstatSync(descriptor)
    if (
      raw.byteLength !== info.size ||
      after.ino !== info.ino ||
      after.dev !== info.dev ||
      after.mode !== info.mode ||
      after.uid !== info.uid ||
      after.gid !== info.gid ||
      after.nlink !== 1 ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    )
      throw new Error("Preparation public artifact changed")
    return raw.toString("utf8")
  } finally {
    closeSync(descriptor)
  }
}

async function request(input: Record<string, unknown>, timeout: number): Promise<unknown> {
  protectedParent()
  const info = lstatSync(SOCKET)
  if (
    !info.isSocket() ||
    info.isSymbolicLink() ||
    info.uid !== 0 ||
    info.gid !== process.getgid?.() ||
    (info.mode & 0o777) !== 0o660
  )
    throw new Error("Preparation root service unavailable")
  const raw = canonicalJson({ schema: 1, ...input })
  if (Buffer.byteLength(raw) >= MAXIMUM) throw new Error("Preparation request exceeds bound")
  return new Promise((resolve, reject) => {
    const client = createConnection({ path: SOCKET })
    const chunks: Buffer[] = []
    let size = 0
    client.setTimeout(timeout, () =>
      client.destroy(new Error("Preparation root service timed out"))
    )
    client.once("connect", () => client.end(raw + "\n"))
    client.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAXIMUM) return client.destroy(new Error("Preparation response exceeds bound"))
      chunks.push(chunk)
    })
    client.once("error", reject)
    client.once("end", () => {
      try {
        const received = Buffer.concat(chunks).toString("utf8")
        if (!received.endsWith("\n") || received.slice(0, -1).includes("\n"))
          throw new Error("Preparation response unavailable")
        const value = JSON.parse(received)
        if (canonicalJson(value) + "\n" !== received)
          throw new Error("Preparation response unavailable")
        resolve(value)
      } catch (error) {
        reject(error)
      }
    })
  })
}

/** One installed unit: authenticated public policy, root acquisition, signed compiler, exact catalog. */
export async function loadInstalledPreparationAuthority(): Promise<
  InstalledPreparationAuthority | undefined
> {
  try {
    lstatSync(POLICY)
    lstatSync(PUBLIC)
    lstatSync(SOCKET)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  const rawPolicy = readPublic(POLICY),
    publicKey = readPublic(PUBLIC)
  const policy = trustedPreparationHostPolicySchema.parse(JSON.parse(rawPolicy))
  if (
    policy.schema !== "lyrashield-preparation-host-policy/2" ||
    canonicalJson(policy) !== rawPolicy
  )
    throw new Error("Production preparation policy unavailable")
  const installed = await observeInstalledExecutionAuthority()
  const delegation = requireCurrentPreparationDelegation(installed.preparation, installed)
  requirePreparationExecutionContext({ environment: "PRODUCTION", installed }, policy)
  const key = createPublicKey(publicKey)
  if (
    sha256Hex(rawPolicy) !== delegation.preparationPolicyChecksum ||
    createHash("sha256")
      .update(key.export({ format: "der", type: "spki" }))
      .digest("hex") !== delegation.issuerKeyHash
  )
    throw new Error("Production preparation pin unavailable")
  const sourceUrl = process.env.LYRASHIELD_PREPARATION_SOURCE_DATABASE_URL,
    authorityUrl = process.env.LYRASHIELD_SCAN_EXECUTION_DATABASE_URL
  if (!sourceUrl || !authorityUrl) throw new Error("Source database installation unavailable")
  const sourceEndpoint = new URL(sourceUrl),
    authorityEndpoint = new URL(authorityUrl)
  if (
    sourceEndpoint.hostname !== authorityEndpoint.hostname ||
    (sourceEndpoint.port || "5432") !== (authorityEndpoint.port || "5432") ||
    sourceEndpoint.pathname !== authorityEndpoint.pathname ||
    sourceEndpoint.username === authorityEndpoint.username
  )
    throw new Error("Source database endpoint unavailable")
  const sourcePool = new Pool({
    connectionString: sourceUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
  })
  try {
    const sourceClient = await sourcePool.connect()
    try {
      await sourceClient.query("BEGIN READ ONLY")
      await sourceClient.query("SET LOCAL statement_timeout='5s'")
      await sourceClient.query("SELECT app.require_scan_preparation_source_role()")
      await sourceClient.query("COMMIT")
    } catch (error) {
      await sourceClient.query("ROLLBACK").catch(() => {})
      throw error
    } finally {
      sourceClient.release()
    }
  } finally {
    await sourcePool.end()
  }
  const base = createTrustedPreparationCompiler({
    hostPolicy: policy,
    issuerPublicKey: publicKey,
    readExecutionContext: async () => {
      throw new Error("Production context requires installed observation")
    },
    readStagingRecord: (authority) =>
      request(
        {
          method: "bind",
          operationId: authority.attempt.operationId,
          authority: {
            attempt: authority.attempt,
            executionPlan: authority.executionPlan,
            executionPlanHash: authority.executionPlanHash,
            targetSnapshotDigest: authority.targetSnapshotDigest,
            scopeDigest: authority.scopeDigest,
            policyDigest: authority.policyDigest,
            workerGrantId: authority.workerGrantId,
          },
        },
        3000
      ),
  })
  const compiler: ScanPreparationCompiler = async (authority) => {
    const compiled = await base(authority)
    const response = await request(
      {
        method: "install",
        operationId: authority.attempt.operationId,
        attemptId: authority.attempt.attemptId,
        descriptors: compiled.executors.map((executor) =>
          executor.spec.kind === "container" ? executor.spec.resourceDescriptor : undefined
        ),
      },
      3000
    )
    if (canonicalJson(response) !== '{"installed":true}')
      throw new Error("Preparation catalog unavailable")
    return compiled
  }
  if (!base.verifyPreparedCommand)
    throw new Error("Production preparation action verifier unavailable")
  compiler.verifyPreparedCommand = base.verifyPreparedCommand
  return Object.freeze({
    compiler,
    async stageOperation(operationId: string) {
      const credential = scanDispatchWorkerReceiptCredential(operationId)
      if (!credential) throw new Error("Source staging requires assigned worker credential")
      const response = await request(
        {
          method: "stage",
          operationId,
          credentialHash: createHash("sha256").update(credential).digest("hex"),
        },
        180000
      )
      if (canonicalJson(response) !== '{"staged":true}') throw new Error("Source stage unavailable")
    },
  })
}
