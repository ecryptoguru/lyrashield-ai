import { S3Client } from "@aws-sdk/client-s3"
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs"
import { z } from "zod"
import { StoredJournalSealEvidenceReader } from "./journal-seal-evidence"
import {
  NativeInstalledJournalSealGate,
  readInstalledJournalSealControlPolicy,
} from "./native-journal-seal-gate"
import type { AuthoritySqlPool } from "./postgres-mirror"
import { ProtectedJournalSealPinStore } from "./protected-journal-seal-pin-store"
import { R2ConditionalObjectStore } from "./r2-store"

const configurationPath = "/etc/lyrashield/control/journal-seal-control-storage.json"
const checkpointPath = "/etc/lyrashield/control/journal-seal-checkpoint-key.txt"
const toolConfigurationPath = "/etc/lyrashield/control/tool-journal-seal-control-storage.json"
const toolCheckpointPath = "/etc/lyrashield/control/tool-journal-seal-checkpoint-key.txt"
function requireProof(value: unknown): asserts value {
  if (!value) throw new Error("Installed protected seal pin storage unavailable")
}
function privateBytes(
  path:
    | typeof configurationPath
    | typeof checkpointPath
    | typeof toolConfigurationPath
    | typeof toolCheckpointPath
): Buffer {
  requireProof(process.getuid?.() === 0)
  for (const parent of ["/etc", "/etc/lyrashield", "/etc/lyrashield/control"]) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed protected root ancestors
    const directory = lstatSync(parent)
    requireProof(
      directory.isDirectory() &&
        !directory.isSymbolicLink() &&
        directory.uid === 0 &&
        (directory.mode & 0o022) === 0
    )
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- only two fixed root credential paths
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    requireProof(
      before.isFile() &&
        before.uid === 0 &&
        before.gid === 0 &&
        before.nlink === 1 &&
        (before.mode & 0o777) === 0o400 &&
        before.size > 0 &&
        before.size <= 8192
    )
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- verified bounded private root descriptor
    const bytes = readFileSync(fd)
    const after = fstatSync(fd)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- same fixed credential descriptor
    const current = lstatSync(path)
    for (const item of [after, current])
      requireProof(
        item.dev === before.dev &&
          item.ino === before.ino &&
          item.size === before.size &&
          item.mtimeMs === before.mtimeMs &&
          item.ctimeMs === before.ctimeMs &&
          item.uid === before.uid &&
          item.gid === before.gid &&
          item.mode === before.mode &&
          item.nlink === 1
      )
    requireProof(bytes.length === before.size)
    return bytes
  } finally {
    closeSync(fd)
  }
}
const storageSchema = z
  .object({
    schema: z.literal("lyrashield-root-control-r2-storage/1"),
    accountId: z.string().regex(/^[a-f0-9]{32}$/),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
    accessKeyId: z.string().regex(/^[a-f0-9]{32}$/),
    secretAccessKey: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

/** Real root-installed factory; no caller chooses credentials, endpoints, keys or next pins. */
export function createInstalledJournalSealPinStore(
  source: string,
  evidence: StoredJournalSealEvidenceReader,
  epochs: AuthoritySqlPool,
  stream: "controller" | "tools" = "controller"
) {
  requireProof(evidence instanceof StoredJournalSealEvidenceReader)
  requireProof(stream === "controller" || stream === "tools")
  const policy = readInstalledJournalSealControlPolicy(source, stream)
  evidence.assertInstalledStream({
    epochId: policy.epochId,
    supervisorInstanceId: policy.supervisorInstanceId,
    originalKeyHash: policy.originalKeyHash,
    wrapperKeyHash: policy.wrapperKeyHash,
    checkpointKeyHash: policy.checkpointKeyHash,
  })
  const config = storageSchema.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        privateBytes(stream === "tools" ? toolConfigurationPath : configurationPath)
      )
    )
  )
  requireProof(
    config.accountId === policy.controlAccountId &&
      config.bucket === policy.controlBucket &&
      config.accessKeyId === policy.controlCredentialId
  )
  const checkpointSecret = new TextDecoder("utf-8", { fatal: true }).decode(
    privateBytes(stream === "tools" ? toolCheckpointPath : checkpointPath)
  )
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    maxAttempts: 1,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  })
  try {
    const store = new ProtectedJournalSealPinStore(
      new R2ConditionalObjectStore(client, config.bucket, 4096, 5000),
      evidence,
      new NativeInstalledJournalSealGate(epochs, source, stream),
      {
        epochId: policy.epochId,
        epoch: policy.epoch,
        supervisorInstanceId: policy.supervisorInstanceId,
        productRevision: source,
        checkpointSecret,
        checkpointKeyHash: policy.checkpointKeyHash,
        controlAccountId: config.accountId,
        controlBucket: config.bucket,
        genesisRecordHash: policy.genesisRecordHash,
      }
    )
    return { store, close: () => client.destroy() }
  } catch {
    client.destroy()
    throw new Error("Installed protected seal pin storage unavailable")
  }
}
