import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs"
import { performance } from "node:perf_hooks"
import {
  canonicalJson,
  sha256Hex,
  IndependentAuthorityJournal,
  StoredJournalSealEvidenceReader,
  ProtectedJournalSealPinStore,
  assertScanJournalSealRolePrerequisites,
  readInstalledJournalSealControlPolicy,
  restoreJournalState,
  encodeSealedAttempts,
  validateSealedRecoverySnapshot,
  MAX_SNAPSHOT_BYTES,
  sealedRecoverySchema,
  projectSandboxToolHistory,
  sandboxToolEventSchema,
} from "./publisher-runtime.mjs"

const ROOT_FILES = new Set([
  "/etc/lyrashield/control/journal-seal-publisher.json",
  "/etc/lyrashield/control/journal-seal-control-storage.json",
  "/etc/lyrashield/control/journal-seal-checkpoint-key.txt",
  "/etc/lyrashield/control/tool-journal-seal-publisher.json",
  "/etc/lyrashield/control/tool-journal-seal-control-storage.json",
  "/etc/lyrashield/control/tool-journal-seal-checkpoint-key.txt",
])
function check(value) {
  if (!value) throw new Error("Root journal seal publication is unavailable")
}

/** Routine publication reads installed credentials; it never commissions an epoch or genesis. */
export function readRootPublicationBytes(path) {
  check(process.platform === "linux" && process.getuid?.() === 0 && ROOT_FILES.has(path))
  for (const parent of ["/etc", "/etc/lyrashield", "/etc/lyrashield/control"]) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed root installation ancestors
    const info = lstatSync(parent)
    check(info.isDirectory() && !info.isSymbolicLink() && info.uid === 0 && !(info.mode & 0o022))
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed allowlisted root credential paths
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    check(
      before.isFile() &&
        before.uid === 0 &&
        before.gid === 0 &&
        before.nlink === 1 &&
        (before.mode & 0o777) === 0o400 &&
        before.size > 0 &&
        before.size <= 16384
    )
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- protected bounded descriptor, never caller input
    const bytes = readFileSync(fd)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reobserve the same allowlisted installed file
    for (const after of [fstatSync(fd), lstatSync(path)])
      for (const field of [
        "dev",
        "ino",
        "size",
        "mtimeMs",
        "ctimeMs",
        "uid",
        "gid",
        "mode",
        "nlink",
      ])
        check(after[field] === before[field])
    check(bytes.length === before.size)
    return bytes
  } finally {
    closeSync(fd)
  }
}

const ENVIRONMENT_KEYS = new Set([
  "LYRASHIELD_SUPERVISOR_JOURNAL_PATH",
  "LYRASHIELD_SUPERVISOR_INDEPENDENT_JOURNAL_PATH",
  "LYRASHIELD_SUPERVISOR_SIGNING_SECRET",
  "LYRASHIELD_SUPERVISOR_MIRROR_SIGNING_SECRET",
  "LYRASHIELD_SUPERVISOR_INSTANCE_ID",
  "LYRASHIELD_SUPERVISOR_CONTROL_TOKEN",
  "LYRASHIELD_SUPERVISOR_JOURNAL_AUTHORITY_JSON",
  "LYRASHIELD_SCAN_EXECUTION_DATABASE_URL",
  "LYRASHIELD_SUPERVISOR_MIRROR_DATABASE_URL",
  "LYRASHIELD_SUPERVISOR_JOURNAL_STORAGE_JSON",
  "LYRASHIELD_AUTHORITY_EPOCH_ID",
  "LYRASHIELD_PRODUCT_REVISION",
  "LYRASHIELD_RUNTIME_POLICY_DIGEST",
  "LYRASHIELD_PROVIDER_GATEWAY_URL",
  "LYRASHIELD_PROVIDER_GATEWAY_CONTROL_TOKEN",
  "LYRASHIELD_SUPERVISOR_CGROUP_ROOT",
])
export function parseRootPublicationConfiguration(bytes, source) {
  check(/^[a-f0-9]{40}$/.test(source) && bytes.length > 0 && bytes.length <= 16384)
  const config = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  check(
    config &&
      typeof config === "object" &&
      !Array.isArray(config) &&
      Object.keys(config).sort().join(",") ===
        "environment,mirrorDatabaseUrl,productRevision,schema,sealDatabaseUrl" &&
      config.schema === "lyrashield-root-journal-seal-publisher/1" &&
      config.productRevision === source &&
      config.environment &&
      typeof config.environment === "object" &&
      !Array.isArray(config.environment) &&
      Object.keys(config.environment).length === ENVIRONMENT_KEYS.size
  )
  for (const [name, value] of Object.entries(config.environment))
    check(
      ENVIRONMENT_KEYS.has(name) &&
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 8192 &&
        !value.includes("\0")
    )
  check(config.environment.LYRASHIELD_PRODUCT_REVISION === source)
  for (const name of [
    "LYRASHIELD_SUPERVISOR_JOURNAL_PATH",
    "LYRASHIELD_SUPERVISOR_INDEPENDENT_JOURNAL_PATH",
  ])
    check(
      config.environment[name].startsWith("/") &&
        !config.environment[name].split("/").includes("..")
    )
  const connections = [
    config.sealDatabaseUrl,
    config.mirrorDatabaseUrl,
    config.environment.LYRASHIELD_SCAN_EXECUTION_DATABASE_URL,
    config.environment.LYRASHIELD_SUPERVISOR_MIRROR_DATABASE_URL,
  ]
  const targets = []
  const roles = connections.map((value) => {
    check(typeof value === "string" && value.length <= 8192)
    const url = new URL(value),
      role = decodeURIComponent(url.username)
    check(
      /^postgres(?:ql)?:$/.test(url.protocol) &&
        /^[a-z][a-z0-9_]{2,62}$/.test(role) &&
        !["postgres", "service_role", "app_runtime_prod", "app_system_prod"].includes(role)
    )
    // Both native gates must lock the execution database; both mirror readers must observe the same store.
    url.username = ""
    url.password = ""
    url.protocol = "postgres:"
    if (!url.port) url.port = "5432"
    targets.push(url.href)
    return role
  })
  check(new Set(roles).size === roles.length)
  check(targets[0] === targets[2] && targets[1] === targets[3])
  return config
}

/** Distinct from the nested pin-control lock. The native action gate also serializes appends. */
export class RootJournalSealPublicationFence {
  constructor(pool, source, stream = "controller") {
    check(stream === "controller" || stream === "tools")
    this.pool = pool
    this.source = source
    this.stream = stream
  }
  async run(operation) {
    const policy = readInstalledJournalSealControlPolicy(this.source, this.stream),
      client = await this.pool.connect()
    let active = true,
      committed = false,
      locked = false,
      released = false
    const deadline = performance.now() + 90_000,
      invalidate = () => {
        active = false
      }
    const assertActive = () => check(active && performance.now() < deadline)
    try {
      check(client.on && client.off)
      client.on("error", invalidate)
      client.on("end", invalidate)
      const clean = await client.query(
        "SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND pid=pg_catalog.pg_backend_pid() AND classid=1819234670 AND objid=1 AND objsubid=2 AND granted) AS clean",
        []
      )
      check(clean.rows[0]?.clean === true)
      const gate = await client.query(
        "SELECT pg_catalog.pg_try_advisory_lock(1819234670,1) AS held",
        []
      )
      check(gate.rows[0]?.held === true)
      locked = true
      await client.query("BEGIN", [])
      await client.query("SET LOCAL statement_timeout='10s'", [])
      await client.query("SET LOCAL lock_timeout='3s'", [])
      await client.query("SET LOCAL idle_in_transaction_session_timeout='100s'", [])
      await assertScanJournalSealRolePrerequisites(client, policy.databaseRole)
      const epoch = await client.query(
        `SELECT id FROM "ScanAuthorityEpoch" WHERE id=$1 AND epoch=$2::integer
        AND "isOpen"=true AND "openKey"='open' AND epoch=(SELECT max(epoch) FROM "ScanAuthorityEpoch") FOR SHARE`,
        [policy.epochId, String(policy.epoch)]
      )
      const stream = await client.query(
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
      check(epoch.rows.length === 1 && stream.rows.length === 1)
      assertActive()
      const result = await operation(assertActive)
      assertActive()
      check(
        canonicalJson(readInstalledJournalSealControlPolicy(this.source, this.stream)) ===
          canonicalJson(policy)
      )
      await client.query("COMMIT", [])
      committed = true
      check(
        (await client.query("SELECT pg_catalog.pg_advisory_unlock(1819234670,1) AS released", []))
          .rows[0]?.released === true
      )
      locked = false
      released = true
      return result
    } finally {
      active = false
      if (!committed) {
        try {
          await client.query("ROLLBACK", [])
        } catch {
          /* discard */
        }
      }
      if (locked && committed) {
        try {
          check(
            (
              await client.query(
                "SELECT pg_catalog.pg_advisory_unlock(1819234670,1) AS released",
                []
              )
            ).rows[0]?.released === true
          )
        } catch {
          /* discard the connection after unknown release */
        }
      }
      client.off?.("error", invalidate)
      client.off?.("end", invalidate)
      client.release(!released)
    }
  }
}

/** Called only inside journal.withPublication and the native root fence; never nested journal.load(). */
export async function createPublicationRecoverySnapshot(
  publication,
  stream,
  assertActive,
  kind = "controller"
) {
  check(kind === "controller" || kind === "tools")
  check(
    publication.independent instanceof IndependentAuthorityJournal &&
      Number.isSafeInteger(stream.lastSequence) &&
      stream.lastSequence > 0
  )
  const installedStream = publication.independent.streamIdentity()
  check(
    installedStream.epochId === stream.epochId &&
      installedStream.supervisorInstanceId === stream.supervisorInstanceId
  )
  if (kind === "tools") check(stream.supervisorInstanceId.endsWith(".tools"))
  assertActive()
  const originals = await publication.original.load(),
    wrappers = await publication.wrapper.load()
  const original = originals[stream.lastSequence - 1],
    wrapper = wrappers[stream.lastSequence - 1]
  check(
    original &&
      wrapper &&
      originals.length === wrappers.length &&
      original.hash === stream.originalLastHash &&
      wrapper.hash === stream.wrapperLastHash &&
      canonicalJson(wrapper.payload.payload) === canonicalJson(original)
  )
  const confirmed = await publication.independent.loadConfirmedRange(stream.lastSequence - 1, {
    maxRecords: 1,
    maxBytes: MAX_SNAPSHOT_BYTES,
  })
  check(
    canonicalJson(confirmed.records[0]) === canonicalJson(wrapper) &&
      confirmed.head?.hash === wrappers.at(-1)?.hash
  )
  const attempts = new Map(),
    commands = new Map()
  const selected = originals.slice(0, stream.lastSequence)
  if (kind === "controller") restoreJournalState(selected, attempts, commands)
  else
    projectSandboxToolHistory(
      selected.map((record) => sandboxToolEventSchema.parse(record.payload))
    )
  const raw = {
    schema:
      kind === "tools"
        ? "lyrashield-supervisor-tool-recovery-snapshot/1"
        : "lyrashield-supervisor-recovery-snapshot/1",
    epochId: stream.epochId,
    supervisorInstanceId: stream.supervisorInstanceId,
    sequence: stream.lastSequence,
    originalHash: original.hash,
    wrapperHash: wrapper.hash,
    ...(kind === "tools"
      ? { records: selected }
      : {
          attempts: encodeSealedAttempts(attempts),
          commands: [...commands]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([id, state]) => ({ id, state: { ...state } })),
        }),
  }
  const snapshot = kind === "tools" ? raw : sealedRecoverySchema.parse(raw)
  check(canonicalJson(snapshot) === canonicalJson(raw))
  if (kind === "controller") validateSealedRecoverySnapshot(snapshot)
  const bytes = Buffer.from(canonicalJson(snapshot))
  check(bytes.length <= MAX_SNAPSHOT_BYTES)
  check(
    canonicalJson(originals) === canonicalJson(await publication.original.load()) &&
      canonicalJson(wrappers) === canonicalJson(await publication.wrapper.load())
  )
  assertActive()
  return {
    bytes,
    sequence: snapshot.sequence,
    originalLastHash: snapshot.originalHash,
    wrapperLastHash: snapshot.wrapperHash,
  }
}

/** Hashes acknowledged, immutable bytes while the installed pin is held unchanged. */
export async function observePublishedJournal({
  pin,
  evidence,
  controlStore,
  store,
  mirror,
  stream,
}) {
  check(
    pin instanceof ProtectedJournalSealPinStore &&
      evidence instanceof StoredJournalSealEvidenceReader
  )
  return pin.withBoundedContinuation(stream, async (anchor) => {
    const seal = anchor.seal
    check(
      seal.schema === "lyrashield-journal-seal/2" &&
        seal.lastSequence === anchor.journalHead.sequence
    )
    const key = `journal-seal-pins/${stream.epochId}/${stream.supervisorInstanceId}/current`
    const read = async () => {
      anchor.assertActive()
      const envelope = await controlStore.readBounded(key, 4096)
      check(envelope?.etag && envelope.bytes.length > 0)
      const hash = sha256Hex(Buffer.from(envelope.bytes).toString("utf8"))
      const ack = await controlStore.readBounded(
        `journal-seal-pins/${stream.epochId}/${stream.supervisorInstanceId}/observed-cas-acks/${hash}`,
        4096
      )
      const observed = await evidence.readCurrentSealEvidence(stream)
      const r2 = await store.readBounded(
        `epochs/${stream.epochId}/supervisors/${stream.supervisorInstanceId}/head`,
        16384
      )
      const pg = await mirror.readHeadBounded(16384)
      check(
        ack?.etag &&
          observed &&
          r2?.etag &&
          pg &&
          canonicalJson(observed.seal) === canonicalJson(seal) &&
          canonicalJson(observed.journalHead) === canonicalJson(anchor.journalHead) &&
          Buffer.from(r2.bytes).toString("utf8") === canonicalJson(pg)
      )
      const envelopeBody = JSON.parse(Buffer.from(envelope.bytes).toString("utf8"))
      check(canonicalJson(envelopeBody.pin) === canonicalJson(anchor.pin))
      anchor.assertActive()
      return { envelope, ack, observed, r2, pg, hash }
    }
    const first = await read(),
      second = await read()
    for (const field of ["envelope", "ack", "r2"])
      check(
        first[field].etag === second[field].etag &&
          Buffer.from(first[field].bytes).equals(Buffer.from(second[field].bytes))
      )
    check(
      canonicalJson(first.observed) === canonicalJson(second.observed) &&
        canonicalJson(first.pg) === canonicalJson(second.pg)
    )
    const headHash = sha256Hex(canonicalJson(first.pg))
    check(headHash === seal.independentHeadHash)
    return {
      sealSchema: seal.schema,
      sealHash: seal.sealHash,
      recoverySnapshotSha256: seal.recoverySnapshotSha256,
      pinEnvelopeHash: first.hash,
      observedControlCasAckHash: sha256Hex(Buffer.from(first.ack.bytes).toString("utf8")),
      observedJournalAckHash: sha256Hex(
        Buffer.from(first.observed.journalObservedAck).toString("utf8")
      ),
      observedSealAckHash: sha256Hex(Buffer.from(first.observed.sealObservedAck).toString("utf8")),
      postgresHeadHash: headHash,
      r2HeadHash: headHash,
      sequence: seal.lastSequence,
    }
  })
}
