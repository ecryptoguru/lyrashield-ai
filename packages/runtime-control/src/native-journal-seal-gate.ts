import { execFileSync } from "node:child_process"
import { lstatSync } from "node:fs"
import { performance } from "node:perf_hooks"
import { z } from "zod"
import type { AuthoritySqlPool } from "./postgres-mirror"
import { assertScanJournalSealRolePrerequisites } from "./journal-seal-role-prerequisites"

const id = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .refine((x) => !x.includes(".."))
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const policySchema = z
  .object({
    schema: z.literal("lyrashield-journal-seal-control/1"),
    productRevision: z.string().regex(/^[a-f0-9]{40}$/),
    epochId: id,
    epoch: z.number().int().positive(),
    streamId: id,
    supervisorInstanceId: id,
    originalKeyHash: hash,
    wrapperKeyHash: hash,
    checkpointKeyHash: hash,
    controlAccountId: z.string().regex(/^[a-f0-9]{32}$/),
    controlCredentialId: z.string().regex(/^[a-f0-9]{32}$/),
    controlBucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
    genesisRecordHash: hash,
    databaseRole: z.string().regex(/^[a-z][a-z0-9_]{2,62}$/),
    authorityDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    runtimePolicyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict()
export type JournalSealControlPolicy = z.infer<typeof policySchema>
export interface JournalSealControlProof {
  policy: JournalSealControlPolicy
  assertActive(): void
}
export interface JournalSealControlGate {
  withAuthorizedStream<T>(
    stream: { epochId: string; supervisorInstanceId: string },
    action: (proof: JournalSealControlProof) => Promise<T>
  ): Promise<T>
}
function fail(): never {
  throw new Error("Installed journal seal control authority unavailable")
}
function check(value: unknown): asserts value {
  if (!value) fail()
}
const helper = "/opt/lyrashield/runtime-control/paired-runtime-host-observation.py"
const publicPin = "/opt/lyrashield/runtime-control/runtime-qualification-key.json"

/** The root launcher installs exact verified helper/key bytes; no request selects paths or keys. */
export function readInstalledJournalSealControlPolicy(
  source: string,
  stream: "controller" | "tools" = "controller"
): JournalSealControlPolicy {
  check(process.getuid?.() === 0 && /^[a-f0-9]{40}$/.test(source))
  check(stream === "controller" || stream === "tools")
  for (const path of [
    "/opt",
    "/opt/lyrashield",
    "/opt/lyrashield/runtime-control",
    helper,
    publicPin,
  ]) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed protected installation paths
    const file = lstatSync(path)
    check(file.uid === 0 && !file.isSymbolicLink() && (file.mode & 0o022) === 0)
  }
  try {
    const bytes = execFileSync(
      "/usr/bin/python3",
      [helper, (stream === "tools" ? "tool-seal-gate:" : "seal-gate:") + source, publicPin],
      {
        timeout: 10_000,
        maxBuffer: 8192,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          NODE_ENV: "production",
          PATH: "/usr/bin:/bin",
          PYTHONNOUSERSITE: "1",
          PYTHONDONTWRITEBYTECODE: "1",
        },
      }
    )
    const policy = policySchema.parse(JSON.parse(bytes.toString("utf8")))
    check(policy.productRevision === source)
    return policy
  } catch {
    return fail()
  }
}

/** Holds native session serialization plus epoch/installed-stream row locks through CAS invocation. */
export class NativeInstalledJournalSealGate implements JournalSealControlGate {
  constructor(
    private readonly pool: AuthoritySqlPool,
    private readonly source: string,
    private readonly stream: "controller" | "tools" = "controller"
  ) {}
  async withAuthorizedStream<T>(
    stream: { epochId: string; supervisorInstanceId: string },
    action: (proof: JournalSealControlProof) => Promise<T>
  ): Promise<T> {
    const policy = readInstalledJournalSealControlPolicy(this.source, this.stream)
    check(
      policy.epochId === stream.epochId &&
        policy.supervisorInstanceId === stream.supervisorInstanceId
    )
    const client = await this.pool.connect()
    const lockKey = `journal-seal-control:${policy.epochId}:${policy.supervisorInstanceId}`
    let active = true,
      complete = false,
      locked = false
    const deadline = performance.now() + 15_000
    const invalidate = () => {
      active = false
    }
    if (!client.on || !client.off) {
      client.release(true)
      fail()
    }
    client.on("error", invalidate)
    client.on("end", invalidate)
    const assertActive = () => {
      check(active && performance.now() < deadline)
    }
    try {
      const lock = await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held",
        [lockKey]
      )
      check(lock.rows[0]?.held === true)
      locked = true
      await client.query("BEGIN", [])
      await client.query("SET LOCAL statement_timeout='10s'", [])
      await client.query("SET LOCAL lock_timeout='3s'", [])
      await client.query("SET LOCAL idle_in_transaction_session_timeout='20s'", [])
      await assertScanJournalSealRolePrerequisites(client, policy.databaseRole)
      const epoch = await client.query(
        `SELECT id FROM "ScanAuthorityEpoch" WHERE id=$1 AND epoch=$2::integer
        AND "isOpen"=true AND "openKey"='open' AND epoch=(SELECT max(epoch) FROM "ScanAuthorityEpoch") FOR SHARE`,
        [policy.epochId, String(policy.epoch)]
      )
      check(epoch.rows.length === 1)
      const installed = await client.query(
        `SELECT id FROM "ScanSupervisorJournalStream" WHERE id=$1 AND "authorityEpochId"=$2
        AND "supervisorInstanceId"=$3 AND "originalKeyHash"=$4 AND "wrapperKeyHash"=$5 FOR SHARE`,
        [
          policy.streamId,
          policy.epochId,
          policy.supervisorInstanceId,
          policy.originalKeyHash,
          policy.wrapperKeyHash,
        ]
      )
      check(installed.rows.length === 1)
      assertActive()
      const result = await action({ policy, assertActive })
      assertActive()
      // Reobserve protected policy without accepting changed source/epoch/control namespace.
      check(
        JSON.stringify(readInstalledJournalSealControlPolicy(this.source, this.stream)) ===
          JSON.stringify(policy)
      )
      assertActive()
      await client.query("COMMIT", [])
      complete = true
      return result
    } finally {
      active = false
      if (!complete) {
        try {
          await client.query("ROLLBACK", [])
        } catch {
          /* Discard ambiguous connection. */
        }
      }
      if (locked && complete) {
        try {
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockKey])
        } catch {
          complete = false
        }
      }
      client.off("error", invalidate)
      client.off("end", invalidate)
      client.release(!complete)
    }
  }
}
