import { lstat, realpath } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { timingSafeEqual } from "node:crypto"
import { z } from "zod"

// Matches the existing separate PostgreSQL mirror's identifier contract.
const id = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const secret = z.string().refine((value) => Buffer.byteLength(value) >= 32)
const compositionSchema = z
  .object({
    admission: z.literal("closed"),
    epochId: id,
    supervisorInstanceId: id,
    originalPath: z.string().min(1),
    independentPath: z.string().min(1),
    originalSigningSecret: secret,
    independentSigningSecret: secret,
  })
  .strict()

async function pathIdentity(path: string) {
  const absolute = resolve(path)
  // Inputs are trusted service configuration. This inspection never creates a file.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const parent = await realpath(dirname(absolute))
  let identity: { dev: number; ino: number } | null = null
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const stat = await lstat(absolute)
    if (!stat.isFile()) throw new Error("journal paths must be regular files, never symbolic links")
    identity = { dev: stat.dev, ino: stat.ino }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  }
  return { canonical: join(parent, basename(absolute)), identity }
}

/**
 * Read-only composition preflight. It cannot instantiate a production journal,
 * publish a checkpoint, provision an epoch or return physical-effect permission.
 * Path inspection does not establish native ownership against later replacement.
 */
export async function inspectSupervisorIndependentComposition(input: unknown) {
  const options = compositionSchema.parse(input)
  const originalKey = Buffer.from(options.originalSigningSecret),
    independentKey = Buffer.from(options.independentSigningSecret)
  if (originalKey.length === independentKey.length && timingSafeEqual(originalKey, independentKey))
    throw new Error("original and independent signing keys must differ")
  const [original, independent] = await Promise.all([
    pathIdentity(options.originalPath),
    pathIdentity(options.independentPath),
  ])
  if (
    original.canonical === independent.canonical ||
    (original.identity &&
      independent.identity &&
      original.identity.dev === independent.identity.dev &&
      original.identity.ino === independent.identity.ino)
  )
    throw new Error("original and independent journal paths alias the same file")
  return Object.freeze({
    admission: "closed" as const,
    productionEligible: false as const,
    epochId: options.epochId,
    supervisorInstanceId: options.supervisorInstanceId,
    originalPath: original.canonical,
    independentPath: independent.canonical,
    reason:
      "Authenticated persisted full-command, scope, revocation and policy authority is not installed",
  })
}
