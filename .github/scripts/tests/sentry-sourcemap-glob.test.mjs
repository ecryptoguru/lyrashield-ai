import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

test("Sentry build dependencies find source maps and honor exclusions", async (t) => {
  const web = createRequire(new URL("../../../apps/web/package.json", import.meta.url))
  const sentry = createRequire(web.resolve("@sentry/nextjs"))
  const core = createRequire(sentry.resolve("@sentry/bundler-plugin-core"))
  const webpack = createRequire(sentry.resolve("@sentry/webpack-plugin"))
  const bundler = webpack.resolve("@sentry/bundler-plugins/webpack")
  const { globFiles } = webpack(path.resolve(path.dirname(bundler), "../core/glob.js"))
  const directory = await mkdtemp(path.join(tmpdir(), "lyrashield-sentry-glob-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- owned temporary fixture
  await mkdir(path.join(directory, "ignored"))
  for (const file of ["bundle.js", "bundle.js.map", "ignored/private.js.map", "note.txt"]) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed fixture names
    await writeFile(path.join(directory, file), "fixture")
  }
  const patterns = ["**/*.js", "**/*.js.map"]
  const options = { cwd: directory, ignore: ["ignored/**"] }
  const expected = [path.join(directory, "bundle.js"), path.join(directory, "bundle.js.map")].sort()
  assert.equal(core("glob/package.json").version, "14.0.2")
  assert.deepEqual(
    (await core("glob").glob(patterns, { ...options, absolute: true, nodir: true })).sort(),
    expected
  )
  assert.deepEqual((await globFiles(patterns, options)).sort(), expected)
})
