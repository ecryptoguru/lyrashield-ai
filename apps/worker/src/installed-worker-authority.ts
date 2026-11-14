import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync } from "node:fs"
import { createConnection } from "node:net"
import { createHash } from "node:crypto"
import { z } from "zod"
import { nativeEngineResultProofSchema } from "./jobs/run-scan/native-engine-result"
import { createWorkerNativeResultClient } from "./jobs/run-scan/worker-native-result-client"
import { resolveWorkerExecutionProvenance } from "@lyrashield/config"
import { createWorkerBrokerClient } from "./jobs/run-scan/broker-client"
import { createWorkerBrokerPublicationVerifier } from "./jobs/run-scan/worker-publication-client"
import type { WorkerBrokerInstallation } from "./jobs/run-scan/broker-authority"

const installationPath = "/opt/lyrashield-runtime/worker-authority.json"
const observerPath = "/opt/lyrashield-runtime/worker-authority.sock"
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/)
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const stableAuthority = z
  .object({
    productRevision: z.string().regex(/^[a-f0-9]{40}$/),
    workerImageDigest: digest,
    engineRevision: z.string().regex(/^[a-f0-9]{40}$/),
    authorityEpochId: id,
    epoch: z.number().int().positive().max(2147483647),
    workerInstanceId: id,
    workerGrantId: id,
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
const configurationSchema = z
  .object({
    schema: z.literal("lyrashield-worker-broker-installation/1"),
    authority: stableAuthority,
    workerCredential: z
      .string()
      .min(32)
      .max(1024)
      .refine((value) => value.trim() === value && !/[\r\n]/.test(value)),
  })
  .strict()
const observedAuthority = stableAuthority
  .extend({
    purpose: z.literal("production-worker-installed"),
    qualificationDigest: z.string().regex(/^[a-f0-9]{64}$/),
    authorityDigest: digest,
    runtimePolicyDigest: digest,
  })
  .strict()
const cleanupAuthority = observedAuthority
  .extend({ purpose: z.literal("production-worker-installed-cleanup") })
  .strict()

function requireInstallation(value: unknown): asserts value {
  if (!value) throw new Error("Worker authority installation unavailable")
}
function rootAncestry() {
  const uid = process.getuid?.()
  requireInstallation(typeof uid === "number" && uid > 0 && process.getgid?.() !== undefined)
  for (const path of ["/opt", "/opt/lyrashield-runtime"]) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed protected installation ancestry
    const entry = lstatSync(path)
    requireInstallation(
      entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        entry.uid === 0 &&
        (entry.mode & 0o022) === 0
    )
  }
}
function readConfiguration() {
  rootAncestry()
  const fd = openSync(
    installationPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
  try {
    const entry = fstatSync(fd)
    requireInstallation(
      entry.isFile() &&
        entry.uid === 0 &&
        entry.gid === process.getgid?.() &&
        entry.nlink === 1 &&
        (entry.mode & 0o777) === 0o440 &&
        entry.size > 2 &&
        entry.size <= 16384
    )
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- held no-follow descriptor for the fixed protected config
    const bytes = readFileSync(fd)
    const final = fstatSync(fd)
    requireInstallation(
      final.dev === entry.dev &&
        final.ino === entry.ino &&
        final.size === entry.size &&
        final.mtimeMs === entry.mtimeMs &&
        final.ctimeMs === entry.ctimeMs &&
        bytes.length === entry.size
    )
    return {
      configuration: configurationSchema.parse(JSON.parse(bytes.toString("utf8"))),
      hash: createHash("sha256").update(bytes).digest("hex"),
    }
  } finally {
    closeSync(fd)
  }
}
async function readObserver(
  request?:
    | { schema: 1; method: "inventory"; cursor?: string }
    | { schema: 1; method: "cleanup-authority" }
    | { schema: 1; method: "cleanup-inventory"; cursor?: string }
    | { schema: 1; method: "result-proof"; operationId: string }
) {
  rootAncestry()
  const socket = lstatSync(observerPath)
  requireInstallation(
    socket.isSocket() &&
      !socket.isSymbolicLink() &&
      socket.uid === 0 &&
      socket.gid === process.getgid?.() &&
      (socket.mode & 0o777) === 0o660
  )
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const client = createConnection({ path: observerPath })
    let size = 0,
      settled = false
    const chunks: Buffer[] = []
    const timer = setTimeout(() => finish(new Error("Worker authority timed out")), 6000)
    function finish(error?: Error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        client.destroy()
        reject(error)
      } else resolve(Buffer.concat(chunks))
    }
    client.once("connect", () =>
      client.end(request ? JSON.stringify(request) + "\n" : "worker-execution-authority\n")
    )
    client.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (
        size > (["inventory", "cleanup-inventory"].includes(request?.method ?? "") ? 32768 : 8192)
      )
        finish(new Error("Worker authority response exceeds bound"))
      else chunks.push(chunk)
    })
    client.once("end", () => finish())
    client.once("close", () => finish(new Error("Worker authority closed")))
    client.once("error", finish)
  })
  requireInstallation(bytes.length > 2 && bytes.indexOf(10) === bytes.length - 1)
  const value = JSON.parse(bytes.subarray(0, -1).toString("utf8"))
  return request ? value : observedAuthority.parse(value)
}

/** The fixed root-mounted installation is the only production mode source. */
export async function loadProtectedWorkerBrokerInstallation(): Promise<
  WorkerBrokerInstallation | undefined
> {
  try {
    const installed = readConfiguration()
    const observed: z.infer<typeof observedAuthority> | z.infer<typeof cleanupAuthority> =
      await readObserver()
        .then((value) => observedAuthority.parse(value))
        .catch(async () =>
          cleanupAuthority.parse(await readObserver({ schema: 1, method: "cleanup-authority" }))
        )
    const expected = installed.configuration.authority
    const provenance = resolveWorkerExecutionProvenance()
    requireInstallation(
      provenance &&
        expected.productRevision === provenance.productRevision &&
        expected.workerImageDigest === provenance.workerImageDigest &&
        expected.engineRevision === provenance.engineRevision
    )
    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
      if (key !== "expiresAt") requireInstallation(expected[key] === observed[key])
    }
    const expiresAt = new Date(
      Math.min(Date.parse(expected.expiresAt), Date.parse(observed.expiresAt))
    )
    const authority = {
      qualificationDigest: observed.qualificationDigest,
      productRevision: expected.productRevision,
      workerImageDigest: expected.workerImageDigest,
      engineRevision: expected.engineRevision,
      authorityEpochId: expected.authorityEpochId,
      workerInstanceId: expected.workerInstanceId,
      workerGrantId: expected.workerGrantId,
      expiresAt,
    }
    const requireCurrentDescriptor = (value: unknown) => {
      requireInstallation(readConfiguration().hash === installed.hash)
      const current = observedAuthority.parse(value)
      for (const key of Object.keys(observed) as (keyof typeof observed)[]) {
        if (key !== "expiresAt") requireInstallation(current[key] === observed[key])
      }
      requireInstallation(
        Date.parse(current.expiresAt) > Date.now() && expiresAt.getTime() > Date.now()
      )
    }
    const results = createWorkerNativeResultClient(installed.configuration.workerCredential)
    return {
      authority,
      cleanup: {
        async inventory(cursor) {
          if (cursor !== undefined) id.parse(cursor)
          const result = z
            .object({
              schema: z.literal("lyrashield-root-worker-operation-inventory/1"),
              authority: cleanupAuthority,
              operations: z
                .array(
                  z
                    .object({
                      operationId: id,
                      workspaceId: id,
                      scanId: id,
                      attemptId: id,
                      state: z.enum([
                        "PREPARING",
                        "PREPARED",
                        "START_PENDING",
                        "ACTIVE",
                        "STOPPING",
                        "UNKNOWN",
                        "TERMINATED",
                      ]),
                    })
                    .strict()
                )
                .max(32),
            })
            .strict()
            .parse(
              await readObserver({
                schema: 1,
                method: "cleanup-inventory",
                ...(cursor ? { cursor } : {}),
              })
            )
          requireInstallation(readConfiguration().hash === installed.hash)
          for (const key of Object.keys(observed) as (keyof typeof observed)[])
            if (key !== "expiresAt" && key !== "purpose")
              requireInstallation(result.authority[key] === observed[key])
          return result.operations
        },
      },
      results: {
        read: results,
        async proof(operationId) {
          id.parse(operationId)
          const proof = nativeEngineResultProofSchema.parse(
            await readObserver({ schema: 1, method: "result-proof", operationId })
          )
          requireCurrentDescriptor(proof.authority)
          requireInstallation(proof.action.operationId === operationId)
          return proof
        },
        async inventory(cursor) {
          if (cursor !== undefined) id.parse(cursor)
          const result = z
            .object({
              schema: z.literal("lyrashield-root-worker-operation-inventory/1"),
              authority: observedAuthority,
              operations: z
                .array(
                  z
                    .object({
                      operationId: id,
                      workspaceId: id,
                      scanId: id,
                      attemptId: id,
                      state: z.enum([
                        "PREPARING",
                        "PREPARED",
                        "START_PENDING",
                        "ACTIVE",
                        "STOPPING",
                        "UNKNOWN",
                        "TERMINATED",
                      ]),
                    })
                    .strict()
                )
                .max(32),
            })
            .strict()
            .parse(
              await readObserver({ schema: 1, method: "inventory", ...(cursor ? { cursor } : {}) })
            )
          requireCurrentDescriptor(result.authority)
          return result.operations
        },
      },
      async verifyAuthority(input) {
        try {
          if (readConfiguration().hash !== installed.hash) return false
          const current = observedAuthority.parse(await readObserver())
          return (
            current.qualificationDigest === input.qualificationDigest &&
            current.authorityDigest === observed.authorityDigest &&
            current.runtimePolicyDigest === observed.runtimePolicyDigest &&
            current.productRevision === input.productRevision &&
            current.workerImageDigest === input.workerImageDigest &&
            current.engineRevision === input.engineRevision &&
            current.authorityEpochId === input.authorityEpochId &&
            current.epoch === expected.epoch &&
            current.workerInstanceId === input.workerInstanceId &&
            current.workerGrantId === input.workerGrantId &&
            Date.parse(current.expiresAt) > Date.now() &&
            input.expiresAt.getTime() > Date.now()
          )
        } catch {
          return false
        }
      },
      broker: createWorkerBrokerClient(installed.configuration.workerCredential),
      publication: createWorkerBrokerPublicationVerifier(installed.configuration.workerCredential),
    }
  } catch {
    return undefined
  }
}
