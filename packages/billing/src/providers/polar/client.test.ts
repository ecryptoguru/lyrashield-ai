import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  env: {
    POLAR_ACCESS_TOKEN: "polar-sandbox-token",
    POLAR_ENVIRONMENT: "sandbox" as "production" | "sandbox",
  },
}))

vi.mock("@polar-sh/sdk", () => ({
  Polar: class {
    constructor(options: unknown) {
      mocks.construct(options)
    }
  },
}))
vi.mock("@lyrashield/config", () => ({ env: mocks.env }))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { getPolarClient } from "./client"

describe("getPolarClient", () => {
  beforeEach(() => vi.clearAllMocks())

  it("passes the validated environment to the Polar SDK", () => {
    expect(getPolarClient()).not.toBeNull()
    expect(mocks.construct).toHaveBeenCalledWith({
      accessToken: "polar-sandbox-token",
      server: "sandbox",
    })
  })
})
