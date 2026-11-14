/* eslint-disable security/detect-non-literal-fs-filename -- Read-only repository manifest discovery and fixed Docker packaging fixtures. */
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import test from "node:test"

const root = new URL("../../../", import.meta.url)
const dockerfile = readFileSync(new URL("Dockerfile", root), "utf8")

test("dependency install includes the manifest closure consumed by copied workspaces", () => {
  const packages = new Map()
  for (const directory of ["apps", "packages"])
    for (const name of readdirSync(new URL(directory, root))) {
      const path = `${directory}/${name}/package.json`
      let manifest
      try {
        manifest = JSON.parse(readFileSync(new URL(path, root), "utf8"))
      } catch {
        continue
      }
      packages.set(manifest.name, { path, manifest })
    }
  const setup = dockerfile.split("# ─── Stage 2:")[0]
  const copied = new Set(
    [...setup.matchAll(/^COPY (\S+\/package\.json) /gm)].map((match) => match[1])
  )
  const visited = new Set()
  const visit = (name) => {
    if (visited.has(name)) return
    visited.add(name)
    const pkg = packages.get(name)
    assert.ok(pkg, `Missing workspace ${name}`)
    assert.ok(copied.has(pkg.path), `Dependency install omits ${pkg.path}`)
    for (const [dependency, version] of Object.entries({
      ...pkg.manifest.dependencies,
      ...pkg.manifest.devDependencies,
    }))
      if (version.startsWith("workspace:")) visit(dependency)
  }
  for (const [name, pkg] of packages) if (copied.has(pkg.path)) visit(name)
})

test("native and seal helpers use the existing supervisor closure with immutable root ownership", () => {
  const supervisor = dockerfile
    .split("FROM controller-base AS supervisor")[1]
    .split("FROM controller-base AS provider-gateway")[0]
  assert.match(
    supervisor,
    /COPY --from=controller-deps --chown=root:root \/controller-supervisor \.\//
  )
  assert.match(
    supervisor,
    /COPY --chown=root:root ops\/controller\/publish-journal-seal\.mjs ops\/controller\/journal-seal-publication\.mjs ops\/controller\/publisher-runtime\.mjs \.\/src\//
  )
  assert.match(supervisor, /apk add --no-cache docker-cli python3 openssl/)
  assert.match(supervisor, /ENV TSX_DISABLE_CACHE=1/)
  assert.match(
    supervisor,
    /chown -R root:root \/app \/opt\/lyrashield-controller && chmod -R a-w \/app \/opt\/lyrashield-controller/
  )
  assert.match(supervisor, /USER lyrashield/)
  assert.ok(readFileSync(new URL("apps/supervisor/src/native-host-query.ts", root)).length > 0)
})

test("the host acquisition helper uses the immutable root-owned broker closure", () => {
  const controller = dockerfile
    .split("FROM controller-base AS controller")[1]
    .split("FROM controller-base AS supervisor")[0]
  assert.match(controller, /COPY --from=controller-deps --chown=root:root \/controller-broker \.\//)
  assert.match(
    controller,
    /chown -R root:root \/app \/opt\/lyrashield-controller && chmod -R a-w \/app \/opt\/lyrashield-controller/
  )
  assert.match(controller, /ENV TSX_DISABLE_CACHE=1/)
  assert.match(controller, /USER lyrashield/)
})
