import { strict as assert } from "node:assert"
import { test } from "node:test"
import { checkPlaywrightVersions, chromiumIdentity } from "../ci-browser-identity.mjs"

test("accepts matching locked Playwright versions and rejects mismatches", () => {
  assert.equal(checkPlaywrightVersions(["2.0.0", "2.0.0", "2.0.0"]), "2.0.0")
  assert.throws(() => checkPlaywrightVersions(["2.0.0", "1.0.0", "2.0.0"]))
  assert.throws(() => checkPlaywrightVersions(["2.0.0", "2.0.0"]))
})

test("binds the browser path and launched version to locked metadata", () => {
  const browsers = [
    { name: "chromium", revision: "1234", browserVersion: "151.0.7922.34" },
    { name: "chromium-headless-shell", revision: "1235", browserVersion: "151.0.7922.35" },
  ]
  const path = "/tmp/browser/chromium-1234/chrome-linux64/chrome"
  assert.deepEqual(chromiumIdentity(browsers, path), {
    binary:
      "/tmp/browser/chromium_headless_shell-1235/chrome-headless-shell-linux64/chrome-headless-shell",
    version: "151.0.7922.35",
  })
  assert.throws(() => chromiumIdentity(browsers, path.replace("1234", "1236")))
  assert.throws(() => chromiumIdentity(browsers, path.slice(1)))
  assert.throws(() => chromiumIdentity([...browsers, browsers[1]], path))
  assert.throws(() => chromiumIdentity([browsers[0], { ...browsers[1], revision: "../1" }], path))
})
