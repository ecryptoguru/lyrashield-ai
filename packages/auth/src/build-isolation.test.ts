import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("OAuth startup database isolation", () => {
  it("does not seed resources while collecting the production build", async () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build")
    vi.resetModules()
    const { prisma } = await import("@lyrashield/db")
    const lookup = vi
      .spyOn(prisma.oauthResource, "findFirst")
      .mockRejectedValue(new Error("Build attempted database access"))
    try {
      const { auth } = await import("./auth")
      await expect(auth.$context).resolves.toBeDefined()
      expect(lookup).not.toHaveBeenCalled()
    } finally {
      await prisma.$disconnect()
    }
  })

  it("still seeds the configured resource at runtime", async () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-server")
    vi.resetModules()
    const { prisma } = await import("@lyrashield/db")
    const lookup = vi.spyOn(prisma.oauthResource, "findFirst").mockResolvedValue(null)
    const create = vi.spyOn(prisma.oauthResource, "create").mockResolvedValue({
      id: "resource-fixture",
      identifier: new URL("/api/mcp", process.env.NEXT_PUBLIC_APP_URL).toString(),
      name: "LyraShield MCP",
      accessTokenTtl: null,
      refreshTokenTtl: null,
      signingAlgorithm: null,
      signingKeyId: null,
      allowedScopes: [],
      customClaims: null,
      dpopBoundAccessTokensRequired: false,
      disabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      policyVersion: 1,
      metadata: null,
    })
    try {
      const { auth, OAUTH_RESOURCE } = await import("./auth")
      await expect(auth.$context).resolves.toBeDefined()
      expect(lookup).toHaveBeenCalled()
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ identifier: OAUTH_RESOURCE, name: "LyraShield MCP" }),
        })
      )
    } finally {
      await prisma.$disconnect()
    }
  })
})
