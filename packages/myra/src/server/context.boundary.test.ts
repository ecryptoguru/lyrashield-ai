import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("Myra request context boundary", () => {
  it("keeps the Next-only auth module out of the worker-loaded server barrel", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed adjacent source file
    const source = await readFile(new URL("./context.ts", import.meta.url), "utf8")

    expect(source).not.toContain(
      'import { auth, getWorkspaceMembership } from "@lyrashield/auth/server"'
    )
    expect(source).toContain('await import("@lyrashield/auth/server")')
  })
})
