import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs"
import { z } from "zod"
import { authorityActionSchema, type AuthorityAction } from "./authority-fence"
import { canonicalJson } from "./canonical-json"
import type { AuthoritySqlConnection } from "./postgres-mirror"
import {
  createInstalledExecutionAuthorityCapability,
  installedExecutionAuthoritySchema,
  readSupervisorAuthoritySocket,
} from "./installed-execution-authority"

const contextPath = "/opt/lyrashield-runtime/disposable-native-context.json"
const contextSchema = z
  .object({
    schema: z.literal("lyrashield-disposable-native-context/1"),
    owner: z.string().regex(/^[1-9][0-9]*:[1-9][0-9]*$/),
    bootId: z.string().regex(/^[a-f0-9-]{36}$/),
    nonce: z.string().regex(/^[a-f0-9]{64}$/),
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    sourceTree: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .strict()
const disposableSchema = installedExecutionAuthoritySchema
  .omit({ purpose: true, preparation: true })
  .extend({
    purpose: z.literal("disposable-installed"),
    epochId: z.string().regex(/^disposable-[a-f0-9]{32}$/),
    owner: contextSchema.shape.owner,
    bootId: contextSchema.shape.bootId,
    nonce: contextSchema.shape.nonce,
    sourceTree: contextSchema.shape.sourceTree,
    issuedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict()

function requireScope(value: unknown): asserts value {
  if (!value) throw new Error("Disposable installed authority unavailable")
}
function readContext() {
  requireScope(process.getuid?.() !== 0 && process.getgid !== undefined)
  for (const path of ["/opt", "/opt/lyrashield-runtime"]) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed protected installation ancestry
    const stat = lstatSync(path)
    requireScope(
      stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0
    )
  }
  const fd = openSync(contextPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd)
    requireScope(
      before.isFile() &&
        before.uid === 0 &&
        before.gid === process.getgid!() &&
        before.nlink === 1 &&
        (before.mode & 0o777) === 0o440 &&
        before.size > 0 &&
        before.size <= 4096
    )
    const bytes = Buffer.alloc(4097)
    const size = readSync(fd, bytes, 0, bytes.length, 0)
    const after = fstatSync(fd)
    requireScope(
      size === before.size &&
        after.size === before.size &&
        after.ino === before.ino &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs
    )
    return contextSchema.parse(JSON.parse(bytes.subarray(0, size).toString("utf8")))
  } finally {
    closeSync(fd)
  }
}

/** A protected fixture mount selects only disposable authority, never a production identity. */
export function createSupervisorExecutionAuthorityCapability() {
  requireScope(arguments.length === 0)
  try {
    lstatSync(contextPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return createInstalledExecutionAuthorityCapability()
    throw error
  }
  const context = readContext()
  return Object.freeze({
    async verifyAction(client: AuthoritySqlConnection, input: AuthorityAction) {
      const action = authorityActionSchema.parse(input)
      requireScope(canonicalJson(readContext()) === canonicalJson(context))
      const installed = disposableSchema.parse(
        await readSupervisorAuthoritySocket("disposable-execution-authority\n")
      )
      const now = Math.floor(Date.now() / 1000)
      requireScope(
        installed.owner === context.owner &&
          installed.bootId === context.bootId &&
          installed.nonce === context.nonce &&
          installed.sourceRevision === context.sourceRevision &&
          installed.sourceTree === context.sourceTree &&
          installed.epochId === action.authorityEpochId &&
          installed.issuedAt <= now &&
          now < installed.expiresAt &&
          installed.expiresAt <= installed.issuedAt + 3600
      )
      const epoch = await client.query(
        `SELECT id,epoch::text,app.scan_preparation_gate_held() AS held FROM "ScanAuthorityEpoch"
         WHERE id=$1 AND epoch=$2::integer AND "isOpen"=true AND "openKey"='open'
         AND epoch=(SELECT max(epoch) FROM "ScanAuthorityEpoch") FOR SHARE`,
        [installed.epochId, String(installed.epoch)]
      )
      requireScope(
        epoch.rows.length === 1 &&
          epoch.rows[0]?.id === installed.epochId &&
          epoch.rows[0]?.epoch === String(installed.epoch) &&
          epoch.rows[0]?.held === true
      )
      requireScope(
        canonicalJson(await readSupervisorAuthoritySocket("disposable-execution-authority\n")) ===
          canonicalJson(installed) &&
          canonicalJson(readContext()) === canonicalJson(context) &&
          Math.floor(Date.now() / 1000) < installed.expiresAt
      )
      const held = await client.query("SELECT app.scan_preparation_gate_held() AS held", [])
      requireScope(held.rows.length === 1 && held.rows[0]?.held === true)
      return Object.freeze(installed)
    },
  })
}
