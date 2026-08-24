import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  deploymentEnvironment: "billing-staging",
  stagingAdmission: "restricted",
  token: "s".repeat(32),
}))

vi.mock("@lyrashield/config", () => ({
  billingStagingConfigError: (value: Record<string, string>) =>
    value.LYRASHIELD_DEPLOYMENT_ENVIRONMENT === "billing-staging" ? null : "wrong environment",
  env: {
    get LYRASHIELD_DEPLOYMENT_ENVIRONMENT() {
      return state.deploymentEnvironment
    },
    get BILLING_STAGING_ADMISSION() {
      return state.stagingAdmission
    },
    get BILLING_STAGING_ACCESS_TOKEN() {
      return state.token
    },
  },
}))

import {
  BILLING_STAGING_ACCESS_COOKIE,
  createBillingStagingAccessCookieValue,
  hasBillingStagingAccess,
  isValidBillingStagingToken,
} from "./billing-staging-access"

describe("billing staging access session", () => {
  beforeEach(() => {
    state.deploymentEnvironment = "billing-staging"
    state.stagingAdmission = "restricted"
    state.token = "s".repeat(32)
  })

  it("uses an opaque cookie value instead of persisting the access token", () => {
    const now = Date.now()
    const value = createBillingStagingAccessCookieValue(now)
    expect(value).toBeTruthy()
    expect(value).not.toContain(state.token)
    const request = new Request("https://stage.example/dashboard", {
      headers: { cookie: `${BILLING_STAGING_ACCESS_COOKIE}=${value}` },
    })
    expect(hasBillingStagingAccess(request, now)).toBe(true)
    expect(hasBillingStagingAccess(request, now + 8 * 60 * 60 * 1000)).toBe(false)
  })

  it("rejects missing, altered, and production-marked credentials", () => {
    expect(hasBillingStagingAccess(new Request("https://stage.example/dashboard"))).toBe(false)
    expect(
      hasBillingStagingAccess(
        new Request("https://stage.example/dashboard", {
          headers: { cookie: `${BILLING_STAGING_ACCESS_COOKIE}=wrong` },
        })
      )
    ).toBe(false)
    expect(isValidBillingStagingToken("wrong")).toBe(false)
    state.deploymentEnvironment = "production"
    expect(isValidBillingStagingToken(state.token)).toBe(false)
    expect(createBillingStagingAccessCookieValue()).toBeNull()
  })
})
