import assert from "node:assert/strict"
import fs from "node:fs"
import { execFileSync } from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { protectedSessionCookie } from "../paired-runtime-github.mjs"
import { readPrivateRecord } from "../private-record.mjs"
import { dirname } from "node:path"

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "paired-bounded-"))
  const directory = join(root, "lyrashield-paired-records")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test's private temporary fixture
  fs.mkdirSync(directory, { mode: 0o700 })
  const path = join(directory, "reader.cookie")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test's private temporary fixture
  fs.writeFileSync(path, "fixture-cookie", { mode: 0o600 })
  const originalRoot = process.env.RUNNER_TEMP
  process.env.RUNNER_TEMP = root
  t.after(() => {
    if (originalRoot === undefined) delete process.env.RUNNER_TEMP
    else process.env.RUNNER_TEMP = originalRoot
    t.mock.restoreAll()
    syncBuiltinESMExports()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return path
}

test("protected reader consumes a private regular file", (t) => {
  fixture(t)
  assert.equal(protectedSessionCookie(), "fixture-cookie")
})

test("record decoding preserves a UTF-8 BOM for exact-byte authentication", (t) => {
  const path = fixture(t)
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"signed":true}')])
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test's private temporary fixture
  fs.writeFileSync(path, bytes)
  const text = readPrivateRecord(dirname(path), "reader.cookie")
  assert.deepEqual(Buffer.from(text, "utf8"), bytes)
  assert.throws(() => JSON.parse(text))
})

test("protected reader rejects growth after the descriptor size check", (t) => {
  const path = fixture(t)
  const original = fs.fstatSync
  let changed = false
  t.mock.method(fs, "fstatSync", (fd) => {
    const stat = original(fd)
    if (!changed && stat.isFile()) {
      changed = true
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test's private temporary fixture
      fs.appendFileSync(path, "x".repeat(8192))
    }
    return stat
  })
  syncBuiltinESMExports()
  const originalRead = fs.readSync
  let bytesRead = 0
  t.mock.method(fs, "readSync", (...args) => {
    const count = originalRead(...args)
    bytesRead += count
    return count
  })
  syncBuiltinESMExports()
  assert.throws(() => protectedSessionCookie())
  assert.equal(changed, true)
  assert.ok(bytesRead <= 8193)
})

test("protected reader rejects a replacement after opening", (t) => {
  const path = fixture(t)
  const original = fs.fstatSync
  let changed = false
  t.mock.method(fs, "fstatSync", (fd) => {
    const stat = original(fd)
    if (!changed && stat.isFile()) {
      changed = true
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test's private temporary fixture
      fs.renameSync(path, path + ".old")
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test's private temporary fixture
      fs.writeFileSync(path, "replacement", { mode: 0o600 })
    }
    return stat
  })
  syncBuiltinESMExports()
  assert.throws(() => protectedSessionCookie())
})

test("protected reader rejects symlinks, public permissions and oversized input", (t) => {
  const path = fixture(t)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test's private temporary fixture
  fs.renameSync(path, path + ".old")
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test's private temporary fixture
  fs.symlinkSync(path + ".old", path)
  assert.throws(() => protectedSessionCookie())
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test's private temporary fixture
  fs.unlinkSync(path)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test's private temporary fixture
  fs.renameSync(path + ".old", path)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test's private temporary fixture
  fs.chmodSync(path, 0o644)
  assert.throws(() => protectedSessionCookie())
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test's private temporary fixture
  fs.chmodSync(path, 0o600)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test's private temporary fixture
  fs.truncateSync(path, 8193)
  assert.throws(() => protectedSessionCookie())
})

test("protected reader rejects a FIFO without waiting for a writer", { timeout: 1000 }, (t) => {
  const path = fixture(t)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test's private temporary fixture
  fs.unlinkSync(path)
  execFileSync("mkfifo", [path], { timeout: 500 })
  assert.throws(() => protectedSessionCookie())
})

test("protected reader rejects same-size tampering and invalid UTF-8", (t) => {
  const path = fixture(t)
  const original = fs.readSync
  let changed = false
  t.mock.method(fs, "readSync", (...args) => {
    if (!changed) {
      changed = true
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test's private temporary fixture
      fs.writeFileSync(path, "changed-cookie")
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test's private temporary fixture
      fs.utimesSync(path, new Date("2001-01-01"), new Date("2001-01-01"))
    }
    return original(...args)
  })
  syncBuiltinESMExports()
  assert.throws(() => protectedSessionCookie())
  t.mock.restoreAll()
  syncBuiltinESMExports()
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- only this test's private temporary fixture
  fs.writeFileSync(path, Buffer.from([0xff]), { mode: 0o600 })
  assert.throws(() => protectedSessionCookie())
})
