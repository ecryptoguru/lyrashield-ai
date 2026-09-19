import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Every dashboard route needs its own loading.tsx — the (dashboard) shell
 * streams, so a route without one suspends the whole segment under the
 * nearest ancestor boundary and shows no skeleton of its own.
 */
function* pageDirs(dir: string): Generator<string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (statSync(full).isDirectory()) {
      yield* pageDirs(full)
    } else if (entry === "page.tsx") {
      yield dir
    }
  }
}

const dashboardDir = new URL("./", import.meta.url).pathname

describe("dashboard route loading boundaries", () => {
  it("covers every page route with a loading.tsx", () => {
    const missing = [...pageDirs(dashboardDir)].filter(
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      (dir) => !existsSync(join(dir, "loading.tsx"))
    )
    expect(missing).toEqual([])
  })
})
