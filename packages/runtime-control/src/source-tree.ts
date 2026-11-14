/* eslint-disable security/detect-non-literal-fs-filename -- Held Linux directory descriptors, no-follow leaf opens, fixed ownership and bounded source trees. */
import { createHash } from "node:crypto"
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  type BigIntStats,
} from "node:fs"
import { isAbsolute, join, resolve } from "node:path"

function fail(): never {
  throw new Error("Staged source tree integrity is unavailable")
}
function identity(info: BigIntStats) {
  return [
    info.dev,
    info.ino,
    info.mode,
    info.uid,
    info.gid,
    info.nlink,
    info.size,
    info.mtimeNs,
    info.ctimeNs,
  ].join(":")
}

/** Production roots are immutable and Linux descriptor-relative; disposable fixtures may be owner-writable. */
export function readSourceTree(
  root: string,
  options: { ownerUid: number; immutable: boolean }
): { stagedTreeDigest: string; entries: Array<{ path: string; bytes: number; checksum: string }> } {
  if (
    !isAbsolute(root) ||
    resolve(root) !== root ||
    !Number.isSafeInteger(options.ownerUid) ||
    options.ownerUid < 0
  )
    fail()
  if (options.immutable && (process.platform !== "linux" || options.ownerUid !== 0)) fail()
  const digest = createHash("sha256")
  const buffer = Buffer.alloc(1024 * 1024)
  const entries: Array<{ path: string; bytes: number; checksum: string }> = []
  let total = 0,
    count = 0
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  const validate = (info: BigIntStats, directory: boolean, device: bigint) => {
    if (
      info.uid !== BigInt(options.ownerUid) ||
      info.dev !== device ||
      (info.mode & BigInt(options.immutable ? 0o222 : 0o022)) !== 0n ||
      (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1n) ||
      (!directory && info.size > 5n * 1024n * 1024n)
    )
      fail()
  }
  const token = (marker: string, path: string) => {
    const name = Buffer.from(path, "utf8")
    const length = Buffer.alloc(8)
    length.writeBigUInt64BE(BigInt(name.length))
    digest.update(marker).update(length).update(name)
  }
  const rootFd = openSync(root, flags | constants.O_DIRECTORY)
  const initial = fstatSync(rootFd, { bigint: true })
  const walk = (fd: number, prefix: string, depth: number) => {
    if (depth > 64) fail()
    const before = fstatSync(fd, { bigint: true })
    validate(before, true, initial.dev)
    // macOS has no descriptor-relative fs API in Node; this path is disposable-only.
    const base = process.platform === "linux" ? `/proc/self/fd/${fd}` : join(root, prefix)
    const children = readdirSync(base, { encoding: "buffer" })
      .sort(Buffer.compare)
      .map((rawName) => {
        const name = rawName.toString("utf8")
        if (
          ++count > 10000 ||
          !Buffer.from(name, "utf8").equals(rawName) ||
          name.includes("/") ||
          name === "." ||
          name === ".."
        )
          fail()
        const path = join(base, name)
        const info = lstatSync(path, { bigint: true })
        validate(info, info.isDirectory(), initial.dev)
        return { name, path, info }
      })
    const directories = children.filter(({ info }) => info.isDirectory())
    for (const child of directories) token("D", prefix + child.name)
    for (const child of children.filter(({ info }) => info.isFile())) {
      token("F", prefix + child.name)
      total += Number(child.info.size)
      if (total > 20 * 1024 * 1024) fail()
      const size = Buffer.alloc(8)
      size.writeBigUInt64BE(child.info.size)
      digest.update(size)
      const checksum = createHash("sha256")
      const source = openSync(child.path, flags)
      try {
        if (identity(fstatSync(source, { bigint: true })) !== identity(child.info)) fail()
        let remaining = Number(child.info.size)
        while (remaining > 0) {
          const bytes = readSync(source, buffer, 0, Math.min(buffer.length, remaining), null)
          if (bytes === 0) fail()
          remaining -= bytes
          digest.update(buffer.subarray(0, bytes))
          checksum.update(buffer.subarray(0, bytes))
        }
        if (
          readSync(source, buffer, 0, 1, null) !== 0 ||
          identity(fstatSync(source, { bigint: true })) !== identity(child.info)
        )
          fail()
      } finally {
        closeSync(source)
      }
      entries.push({
        path: prefix + child.name,
        bytes: Number(child.info.size),
        checksum: checksum.digest("hex"),
      })
    }
    for (const child of directories) {
      const next = openSync(child.path, flags | constants.O_DIRECTORY)
      try {
        if (identity(fstatSync(next, { bigint: true })) !== identity(child.info)) fail()
        walk(next, prefix + child.name + "/", depth + 1)
      } finally {
        closeSync(next)
      }
    }
    if (identity(fstatSync(fd, { bigint: true })) !== identity(before)) fail()
  }
  try {
    walk(rootFd, "", 0)
    if (identity(lstatSync(root, { bigint: true })) !== identity(initial)) fail()
    return { stagedTreeDigest: digest.digest("hex"), entries }
  } finally {
    closeSync(rootFd)
  }
}
