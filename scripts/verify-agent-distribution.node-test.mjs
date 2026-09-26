import assert from "node:assert/strict"
import { test } from "node:test"
import { validatePublishedManifest } from "./verify-agent-distribution.mjs"

test("packed manifest rejects unresolved local dependencies", () => {
  for (const range of ["workspace:^", "link:../agent-plugin", "file:../agent-plugin"]) {
    assert.throws(
      () => validatePublishedManifest({
        name: "lyrashield", version: "0.2.13",
        dependencies: { "@lyrashield/agent-plugin": range },
      }),
      /unresolved dependencies @lyrashield\/agent-plugin/
    )
  }
})

test("packed manifest requires a package identity and accepts registry ranges", () => {
  assert.throws(() => validatePublishedManifest({ name: "lyrashield" }), /valid version/)
  assert.doesNotThrow(() => validatePublishedManifest({
    name: "lyrashield", version: "0.2.13",
    dependencies: { "@lyrashield/agent-plugin": "^0.1.30" },
  }))
})
