/* eslint-disable security/detect-non-literal-fs-filename -- Cleanup revalidates the runner's owned private temp directory before removing it. */
import { lstat, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname } from "node:path"

export default async function teardown() {
  const directory = process.env.LYRASHIELD_TEST_AUTH_MAIL_DIR
  if (!directory) return
  const stat = await lstat(directory)
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    !/^lyrashield-auth-mail-[\w-]+$/.test(basename(directory)) ||
    (await realpath(dirname(directory))) !== (await realpath(tmpdir()))
  ) {
    throw new Error("Refusing to remove an unsafe mail fixture directory")
  }
  await rm(directory, { recursive: true })
}
