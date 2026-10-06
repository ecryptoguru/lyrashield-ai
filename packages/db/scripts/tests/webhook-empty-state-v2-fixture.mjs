import { canonical, sha256, QUEUES, STATES } from "../webhook-empty-state-receipt-v2.mjs"
const H = "a".repeat(64),
  S = "b".repeat(40),
  now = Date.parse("2026-10-05T09:01:00Z")
export function fixture() {
  const authorization = {
    sourceSha: S,
    runId: "123",
    originalAttempt: 1,
    owner: "123:1",
    nonce: "n".repeat(40),
    issuedAt: "2026-10-05T09:00:00Z",
    expiresAt: "2026-10-05T09:30:00Z",
    policySha256: H,
    producerSha256: H,
    workflowSha: S,
    repositoryId: "1286618458",
    ownerId: "116722580",
  }
  const image = {
    imageDigest: `sha256:${H}`,
    sourceSha: S,
    engineRevision: S,
    protocol: "durable-claims/2",
    rehearsalRunId: "122",
    rehearsalSha256: H,
  }
  const backup = {
    objectIdSha256: H,
    versionId: "etag:123",
    encryptedSha256: H,
    dumpSha256: H,
    databaseIdentitySha256: H,
    createdAt: "2026-10-05T08:00:00Z",
    runId: "120",
  }
  const restore = {
    backupSha256: sha256(canonical(backup)),
    runId: "120",
    completedAt: "2026-10-05T08:30:00Z",
    schemaSha256: H,
    auditSha256: H,
    readinessSha256: H,
  }
  const resources = Object.fromEntries(
    ["app", "scanner", "worker", "system", "migration", "backup"].map((name) => [
      name,
      `/fixed/${name}`,
    ])
  )
  const credentials = Object.fromEntries(
    [...Object.keys(resources), "redis"].map((name) => [name, H])
  )
  const databasePrincipals = {
    app: "worker_runtime",
    scanner: "scanner_runtime",
    worker: "worker_runtime",
    system: "system_admin",
    migration: "postgres",
  }
  const policy = {
    ...authorization,
    schemaVersion: "webhook-empty-state-policy/v3",
    enabled: true,
    revoked: false,
    databaseIdentitySha256: H,
    databasePrincipals,
    resources,
    credentials,
    redisIdentitySha256: H,
    admissionValueSha256: H,
    candidate: image,
    fallback: image,
    backup,
    restore,
    actorId: "42",
  }
  const observedAt = new Date(now).toISOString()
  const receipt = {
    schemaVersion: "webhook-empty-state/v3",
    mode: "empty-scheduling",
    authorization,
    evidence: {
      observedAt,
      database: Object.fromEntries(
        Object.entries(resources).map(([name, resourceId]) => [
          name,
          {
            identitySha256: H,
            principalSha256: sha256(name === "backup" ? "postgres" : databasePrincipals[name]),
            credentialSha256: H,
            resourceId,
            observedAt,
          },
        ])
      ),
      redis: { identitySha256: H, credentialSha256: H, owner: "123:1", valueSha256: H },
      writers: ["app", "scanner"].map((name) => ({
        resourceId: resources[name],
        revisions: [{ name: "old", active: false, replicas: 0 }],
      })),
      worker: {
        imageDigest: `sha256:${H}`,
        sourceSha: S,
        engineRevision: S,
        serviceState: "inactive",
        timerState: "inactive",
        containers: 0,
        stopOwner: "123:1",
        stopAt: observedAt,
        stopProofSha256: H,
        startupFenced: true,
      },
      queues: Object.fromEntries(
        QUEUES.map((name) => [
          name,
          {
            counts: Object.fromEntries(STATES.map((state) => [state, 0])),
            schedulers: 0,
            repeats: 0,
          },
        ])
      ),
      nonterminalScans: 0,
      inFlightHandlers: 0,
      trackRows: 0,
      unresolvedParents: 0,
      unknownWriters: 0,
      candidate: image,
      fallback: image,
      backup,
      restore,
    },
  }
  return { receipt, policy }
}
