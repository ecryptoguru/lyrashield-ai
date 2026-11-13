import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"

const binaries = Object.freeze({
  x64: "62c11fbaa08835168c3d1acf8a645ac6268a13a5682c73581388c9df0c622617",
  arm64: "706b030846db08d0dac0392d6f74416e0bbf0d9ac5ecbd54c9046305c10eac59",
})

export function protectedGh(args) {
  const path = "/usr/bin/gh"
  assert.equal(process.platform, "linux")
  const expected = binaries[process.arch]
  assert.ok(expected)
  const file = statSync(path)
  assert.ok(file.isFile() && file.uid === 0 && (file.mode & 0o022) === 0)
  assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), expected)
  try {
    return execFileSync(path, args, {
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString("utf8")
  } catch {
    throw new Error("Protected attestation verification failed")
  }
}
