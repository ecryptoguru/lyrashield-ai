#!/usr/bin/env node
/* eslint-disable security/detect-non-literal-fs-filename -- All link probes and sentinels live in disposable local directories. */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
assert(process.argv[2], "Pass the generated 13-bundle writer fixture directory")
const fixtures = resolve(process.argv[2])

function runTools(root) {
  return spawnSync(
    process.execPath,
    [join(repoRoot, "scripts", "verify-worker-qualification-tools.mjs"), root],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
    }
  )
}

test("the normal 13 qualification regressions still pass", () => {
  const result = runTools(fixtures)
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /pass 13\b/)
  assert.match(result.stdout, /fail 0\b/)
})

for (const kind of ["summary", "case directory", "artifact"]) {
  test(`rejects a linked ${kind} without changing its external sentinel`, (t) => {
    const workspace = mkdtempSync(join(tmpdir(), "lyrashield-fixture-link-probe-"))
    t.after(() => rmSync(workspace, { recursive: true, force: true }))
    const input = join(workspace, "input")
    // The test setup always creates private regular copies; it never preserves
    // operator links into a tree that the test itself will modify.
    cpSync(fixtures, input, { recursive: true, dereference: true })
    const outside = join(workspace, "external")
    mkdirSync(outside)
    const source =
      kind === "summary"
        ? join(input, "summary.json")
        : kind === "case directory"
          ? join(input, "reverse-reuse")
          : join(input, "reverse-reuse", "run.json")
    const sentinel = join(outside, kind === "case directory" ? "case" : "sentinel.json")
    renameSync(source, sentinel)
    symlinkSync(sentinel, source, kind === "case directory" ? "dir" : "file")
    const files =
      kind === "case directory"
        ? ["run.json", "vulnerabilities.json", "http_exchanges.json"].map((file) =>
            join(sentinel, file)
          )
        : [sentinel]
    const before = files.map((file) => readFileSync(file))

    const result = runTools(input)

    // Check external bytes even when the child has already failed. An exit
    // failure alone would miss the original mutation-before-failure defect.
    for (const [index, file] of files.entries()) {
      assert.deepEqual(readFileSync(file), before[index], `${kind}: external sentinel changed`)
    }
    assert.ifError(result.error)
    assert.notEqual(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stderr, /symbolic links are not allowed/i)
  })
}
