import { expect, it, vi } from "vitest"

it("shares the storage instance across reloads while isolating concurrent request values", async () => {
  const original = await import("./scoping")
  vi.resetModules()
  const reloaded = await import("./scoping")

  await original.runWithWorkspaceContext(null, async () => {
    await Promise.all([
      original.runWithDatabaseRLSContext("workspace-a", async () => {
        await Promise.resolve()
        expect(reloaded.getWorkspaceContext()).toBe("workspace-a")
        expect(reloaded.isDatabaseRLSContextBound()).toBe(true)
      }),
      reloaded.runWithWorkspaceContext("workspace-b", async () => {
        await Promise.resolve()
        expect(original.getWorkspaceContext()).toBe("workspace-b")
        expect(original.isDatabaseRLSContextBound()).toBe(false)
      }),
      (async () => {
        await Promise.resolve()
        expect(original.getWorkspaceContext()).toBeNull()
        expect(reloaded.getWorkspaceContext()).toBeNull()
        expect(reloaded.isDatabaseRLSContextBound()).toBe(false)
      })(),
    ])
    expect(original.getWorkspaceContext()).toBeNull()
    expect(reloaded.getWorkspaceContext()).toBeNull()
    expect(reloaded.isDatabaseRLSContextBound()).toBe(false)
  })
})
