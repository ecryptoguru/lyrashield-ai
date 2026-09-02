import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import { test } from "node:test"

test("worker preflight accepts only empty queues and needs no promotion configuration", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "worker-preflight-"))
  try {
    writeFileSync(path.join(directory, "docker"), '#!/bin/sh\nprintf "%s\\n" "$QUEUE_STATE"\n', {
      mode: 0o700,
    })
    const empty = {
      nonterminal: 0,
      scan: { wait: 0, active: 0, delayed: 0, prioritized: 0 },
      webhook: { wait: 0, active: 0, delayed: 0, prioritized: 0 },
    }
    const run = (state) =>
      execFileSync("/bin/sh", [".github/scripts/promote-worker-vm.sh", "--preflight"], {
        env: { PATH: directory, QUEUE_STATE: state },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
    assert.match(run(JSON.stringify(empty)), /Worker empty-queue preflight passed/)
    for (const state of [
      "",
      "not-json",
      JSON.stringify({ ...empty, nonterminal: 1 }),
      JSON.stringify({ ...empty, webhook: { ...empty.webhook, active: 1 } }),
    ]) {
      assert.throws(() => run(state))
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
