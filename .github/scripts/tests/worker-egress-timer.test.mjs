import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("egress refresh is scheduled when its timer is enabled after boot", () => {
  const timer = readFileSync(
    new URL("../../../ops/worker/lyrashield-worker-egress-refresh.timer", import.meta.url),
    "utf8"
  )
  assert.match(timer, /^OnActiveSec=2min$/m)
  assert.match(timer, /^OnUnitActiveSec=5min$/m)
})
