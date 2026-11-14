import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { lstatSync, readFileSync } from "node:fs"

// The root entrypoint has one fixed deployed location; local checks use its source location.
const deployed = import.meta.url === "file:///app/src/publisher-runtime.mjs"
export const publisherDeployed = deployed
if (deployed) {
  const mounts = readFileSync("/proc/self/mountinfo", "utf8")
  const root = mounts
    .split("\n")
    .map((line) => line.split(" "))
    .find((fields) => fields[4] === "/")
  if (process.platform !== "linux" || !root?.[5]?.split(",").includes("ro"))
    throw new Error("Immutable publisher root filesystem is unavailable")
  for (const path of [
    "/app",
    "/app/src",
    "/app/src/publisher-runtime.mjs",
    "/app/src/publish-journal-seal.mjs",
    "/app/src/journal-seal-publication.mjs",
  ]) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed deployed immutable root entrypoint paths
    const file = lstatSync(path)
    if (file.uid !== 0 || file.gid !== 0 || file.isSymbolicLink() || file.mode & 0o222)
      throw new Error("Immutable publisher source is unavailable")
  }
}
const supervisorRoot = new URL(
  deployed ? "../package.json" : "../../apps/supervisor/package.json",
  import.meta.url
)
const supervisor = createRequire(supervisorRoot)
const runtimeEntry = supervisor.resolve("@lyrashield/runtime-control")
const runtime = createRequire(runtimeEntry)
const runtimeSource = new URL("./", pathToFileURL(runtimeEntry))
const supervisorSource = new URL(deployed ? "./" : "../../apps/supervisor/src/", import.meta.url)

export const {
  canonicalJson,
  sha256Hex,
  IndependentAuthorityJournal,
  StoredJournalSealEvidenceReader,
  ProtectedJournalSealPinStore,
  R2ConditionalObjectStore,
  PostgresAuthorityMirror,
  JournalSealPublisher,
  JournalSealPendingError,
  createInstalledJournalSealPinStore,
  deriveSupervisorToolJournalIdentity,
} = await import(pathToFileURL(runtimeEntry).href)
export const { assertScanJournalSealRolePrerequisites } = await import(
  new URL("journal-seal-role-prerequisites.ts", runtimeSource).href
)
export const { readInstalledJournalSealControlPolicy } = await import(
  new URL("native-journal-seal-gate.ts", runtimeSource).href
)
export const { createPgConnectionConfig } = await import(
  pathToFileURL(supervisor.resolve("@lyrashield/db/src/connection-config.ts")).href
)
export const { restoreJournalState } = await import(
  new URL("restore-state.ts", supervisorSource).href
)
export const { encodeSealedAttempts, validateSealedRecoverySnapshot, MAX_SNAPSHOT_BYTES } =
  await import(new URL("sealed-recovery.ts", supervisorSource).href)
export const { sealedRecoverySchema } = await import(
  new URL("sealed-recovery-schema.ts", supervisorSource).href
)
export const { loadSupervisorConfig } = await import(new URL("config.ts", supervisorSource).href)
export const { loadDatabaseSupervisorAuthority } = await import(
  new URL("database-authority.ts", supervisorSource).href
)
export const { loadInstalledSupervisorJournal } = await import(
  new URL("installed-journal.ts", supervisorSource).href
)
export const { supervisorJournalEventSchema } = await import(
  new URL("journal-events.ts", supervisorSource).href
)
export const { sandboxToolEventSchema } = await import(
  new URL("sandbox-tool-journal.ts", supervisorSource).href
)
export const { projectSandboxToolHistory } = await import(
  new URL("sandbox-tool-history.ts", supervisorSource).href
)
export const { S3Client } = runtime("@aws-sdk/client-s3")
export const { Pool } = supervisor("pg")
