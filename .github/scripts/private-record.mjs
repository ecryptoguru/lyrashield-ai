import assert from "node:assert/strict"
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs"
import { join } from "node:path"

// Return only the bytes read from one checked descriptor. Callers authenticate
// those bytes; a pathname or a size observed before reading is not evidence.
export function readPrivateRecord(directory, name, maxBytes = 4096) {
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 1024 * 1024)
  assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/)
  assert.equal(typeof process.getuid, "function")
  assert.equal(typeof constants.O_NOFOLLOW, "number")
  assert.equal(typeof constants.O_NONBLOCK, "number")
  const owner = process.getuid()
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-owned private record directory
  const parent = lstatSync(directory)
  assert.ok(parent.isDirectory() && parent.uid === owner && (parent.mode & 0o077) === 0)
  const path = join(directory, name)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- validated leaf in caller-owned private directory; no-follow/nonblocking open
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    assert.ok(
      before.isFile() &&
        before.uid === owner &&
        before.nlink === 1 &&
        (before.mode & 0o077) === 0 &&
        before.size <= maxBytes
    )
    const bytes = Buffer.allocUnsafe(before.size + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (count === 0) break
      length += count
    }
    const after = fstatSync(fd)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- same checked record path; compare to opened descriptor
    const entry = lstatSync(path)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reject parent replacement during the read
    const currentParent = lstatSync(directory)
    assert.ok(
      length === before.size &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs &&
        after.uid === owner &&
        (after.mode & 0o077) === 0 &&
        after.nlink === 1 &&
        entry.isFile() &&
        entry.dev === before.dev &&
        entry.ino === before.ino &&
        currentParent.isDirectory() &&
        currentParent.dev === parent.dev &&
        currentParent.ino === parent.ino &&
        currentParent.uid === owner &&
        (currentParent.mode & 0o077) === 0
    )
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, length)
    )
  } finally {
    closeSync(fd)
  }
}
