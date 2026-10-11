/* eslint-disable security/detect-non-literal-fs-filename -- This module creates and removes only its own private temporary mail directory. */
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { lstat, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

const CAPTURE_DIRECTORY = "LYRASHIELD_TEST_AUTH_MAIL_DIR"
const OWNED_DIRECTORY = "LYRASHIELD_TEST_AUTH_MAIL_OWNED_DIR"
const PREFIX = "lyrashield-auth-mail-"

/** Ignore caller paths and record a fresh, private directory owned by this run. */
export function createOwnedAuthTestMailDirectory(environment: NodeJS.ProcessEnv = process.env) {
  const directory = mkdtempSync(join(tmpdir(), PREFIX))
  try {
    chmodSync(directory, 0o700)
    environment[CAPTURE_DIRECTORY] = directory
    environment[OWNED_DIRECTORY] = directory
    return directory
  } catch {
    rmSync(directory, { recursive: true, force: true })
    throw new Error("Unable to create private auth mail fixture directory")
  }
}

/** Validate the exact private temp directory created for this runner. */
export function isOwnedAuthTestMailDirectory(
  captureDirectory: string | undefined,
  ownedDirectory: string | undefined
): boolean {
  if (!captureDirectory || captureDirectory !== ownedDirectory) return false
  try {
    const stat = lstatSync(captureDirectory)
    return (
      stat.isDirectory() &&
      (stat.mode & 0o077) === 0 &&
      (!process.getuid || stat.uid === process.getuid()) &&
      new RegExp(`^${PREFIX}[\\w-]+$`).test(basename(captureDirectory)) &&
      realpathSync(dirname(captureDirectory)) === realpathSync(tmpdir())
    )
  } catch {
    return false
  }
}

/** Remove only the exact path created by createOwnedAuthTestMailDirectory. */
export async function cleanupOwnedAuthTestMailDirectory(
  captureDirectory: string | undefined,
  ownedDirectory: string | undefined
) {
  if (!captureDirectory && !ownedDirectory) return
  if (!captureDirectory || captureDirectory !== ownedDirectory) {
    throw new Error("Refusing to remove an unowned mail fixture directory")
  }
  let stat
  try {
    stat = await lstat(captureDirectory)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return
    throw error
  }
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    !new RegExp(`^${PREFIX}[\\w-]+$`).test(basename(captureDirectory)) ||
    (await realpath(dirname(captureDirectory))) !== (await realpath(tmpdir()))
  ) {
    throw new Error("Refusing to remove an unsafe mail fixture directory")
  }
  await rm(captureDirectory, { recursive: true })
}
