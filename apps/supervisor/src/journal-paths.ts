import { lstatSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

/** Canonicalize the parent while refusing a symlink at the journal itself. */
export function inspectJournalPath(path: string) {
  const absolute = resolve(path)
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const parent = realpathSync(dirname(absolute))
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const parentStat = statSync(parent)
  let identity: { dev: number; ino: number } | null = null
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const stat = lstatSync(absolute)
    if (!stat.isFile()) throw new Error("journal paths must be regular files, never symbolic links")
    identity = { dev: stat.dev, ino: stat.ino }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  }
  return {
    canonical: join(parent, basename(absolute)),
    identity,
    parentIdentity: { dev: parentStat.dev, ino: parentStat.ino },
  }
}

/** Journals own their base, lock and every segment-prefixed path. */
export function journalPathsOverlap(
  left: ReturnType<typeof inspectJournalPath>,
  right: ReturnType<typeof inspectJournalPath>
): boolean {
  const sameDirectory =
    left.parentIdentity.dev === right.parentIdentity.dev &&
    left.parentIdentity.ino === right.parentIdentity.ino
  // Protect case-insensitive hosts without relying on OS-specific filesystem guesses.
  // On case-sensitive hosts, choose names that differ by more than case.
  const a = sameDirectory ? basename(left.canonical).normalize("NFD").toLowerCase() : left.canonical
  const b = sameDirectory
    ? basename(right.canonical).normalize("NFD").toLowerCase()
    : right.canonical
  return Boolean(
    a === b ||
    a === `${b}.lock` ||
    b === `${a}.lock` ||
    a === `${b}.segment` ||
    b === `${a}.segment` ||
    a.startsWith(`${b}.segment.`) ||
    b.startsWith(`${a}.segment.`) ||
    (left.identity &&
      right.identity &&
      left.identity.dev === right.identity.dev &&
      left.identity.ino === right.identity.ino)
  )
}
