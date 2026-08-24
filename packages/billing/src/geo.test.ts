import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  deploymentEnvironment: "production",
  stagingAdmission: "off",
  stagingRegion: "usd",
}))

vi.mock("@lyrashield/config", () => ({
  billingStagingConfigError: (value: Record<string, string>) =>
    value.LYRASHIELD_DEPLOYMENT_ENVIRONMENT === "billing-staging" &&
    value.BILLING_STAGING_ADMISSION === "restricted" &&
    (value.BILLING_STAGING_REGION === "usd" || value.BILLING_STAGING_REGION === "inr")
      ? null
      : "invalid staging contract",
  env: {
    TRUSTED_PROXY_IP_HEADER: "x-forwarded-for",
    BILLING_GEO_IP_HEADER: "cf-connecting-ip",
    get LYRASHIELD_DEPLOYMENT_ENVIRONMENT() {
      return mocks.deploymentEnvironment
    },
    get BILLING_STAGING_ADMISSION() {
      return mocks.stagingAdmission
    },
    get BILLING_STAGING_REGION() {
      return mocks.stagingRegion
    },
  },
}))

import { resolveProvider } from "./geo"

function spoofedIndiaRequest() {
  return new Request("https://example.invalid/billing/checkout", {
    headers: { "x-forwarded-for": "192.0.2.44", "cf-ipcountry": "IN" },
  })
}

describe("billing provider region resolution", () => {
  beforeEach(() => {
    mocks.deploymentEnvironment = "production"
    mocks.stagingAdmission = "off"
    mocks.stagingRegion = "usd"
  })

  it("uses the explicit server-side region for a restricted staging session", () => {
    mocks.deploymentEnvironment = "billing-staging"
    mocks.stagingAdmission = "restricted"

    expect(resolveProvider(spoofedIndiaRequest(), true)).toEqual({
      provider: "polar",
      region: "usd",
    })
    mocks.stagingRegion = "inr"
    expect(resolveProvider(new Request("https://example.invalid"), true)).toEqual({
      provider: "razorpay",
      region: "inr",
    })
  })

  it("does not expose the staging override to an unauthenticated request", () => {
    mocks.deploymentEnvironment = "billing-staging"
    mocks.stagingAdmission = "restricted"
    mocks.stagingRegion = "usd"

    expect(resolveProvider(spoofedIndiaRequest(), false)).toEqual({
      provider: "razorpay",
      region: "inr",
    })
  })

  it("cannot activate the staging override in production", () => {
    mocks.stagingAdmission = "restricted"
    mocks.stagingRegion = "inr"

    expect(resolveProvider(new Request("https://app.lyrashieldai.com"), true)).toEqual({
      provider: "polar",
      region: "usd",
    })
  })
})
