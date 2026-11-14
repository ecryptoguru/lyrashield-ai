import { strict as assert } from "node:assert"
import { test } from "node:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  workerImageRehearsalHarnessSha,
  WORKER_IMAGE_REHEARSAL_HARNESS_FILES,
} from "../worker-image-rehearsal-harness-sha.mjs"

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), "harness-sha-"))
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(root, file)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
  return root
}

const allPresent = Object.fromEntries(WORKER_IMAGE_REHEARSAL_HARNESS_FILES.map((f) => [f, "x"]))

test("a working tree with every pinned file present hashes without error", () => {
  const root = fixture(allPresent)
  try {
    assert.match(workerImageRehearsalHarnessSha(root), /^sha256:[a-f0-9]{64}$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("tolerates an intentionally missing pinned file instead of crashing", () => {
  const root = fixture(allPresent)
  try {
    rmSync(path.join(root, WORKER_IMAGE_REHEARSAL_HARNESS_FILES[0]))
    assert.match(workerImageRehearsalHarnessSha(root), /^sha256:[a-f0-9]{64}$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("missing pinned files are tolerated without ignoring active pins in existing files", () => {
  const withoutOne = fixture(allPresent)
  const withChanged = fixture({
    ...allPresent,
    [WORKER_IMAGE_REHEARSAL_HARNESS_FILES[1]]: "changed",
  })
  try {
    rmSync(path.join(withoutOne, WORKER_IMAGE_REHEARSAL_HARNESS_FILES[0]))
    assert.notEqual(
      workerImageRehearsalHarnessSha(withoutOne),
      workerImageRehearsalHarnessSha(withChanged)
    )
  } finally {
    rmSync(withoutOne, { recursive: true, force: true })
    rmSync(withChanged, { recursive: true, force: true })
  }
})

test("a changed pinned file still changes the fingerprint", () => {
  const base = fixture(allPresent)
  const changed = fixture({ ...allPresent, [WORKER_IMAGE_REHEARSAL_HARNESS_FILES[0]]: "y" })
  try {
    assert.notEqual(workerImageRehearsalHarnessSha(base), workerImageRehearsalHarnessSha(changed))
  } finally {
    rmSync(base, { recursive: true, force: true })
    rmSync(changed, { recursive: true, force: true })
  }
})

test("a directory in place of a pinned file is treated as absent, not hashed", () => {
  const root = fixture(allPresent)
  const target = path.join(root, WORKER_IMAGE_REHEARSAL_HARNESS_FILES[0])
  try {
    rmSync(target)
    mkdirSync(target, { recursive: true })
    assert.match(workerImageRehearsalHarnessSha(root), /^sha256:[a-f0-9]{64}$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
