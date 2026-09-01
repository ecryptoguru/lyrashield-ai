import { createHash } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { assessAppOrigin, isAppHost, trustedAppCountry } from "./app-origin"

const originalEnv = { ...process.env }
const certificate = "-----BEGIN CERTIFICATE-----\nAQIDBA==\n-----END CERTIFICATE-----"
const fingerprint = createHash("sha256")
  .update(Buffer.from([1, 2, 3, 4]))
  .digest("hex")

afterEach(() => {
  for (const key of [
    "CLOUDFLARE_ORIGIN_MTLS",
    "CLOUDFLARE_AOP_CERT_SHA256",
    "DEPLOY_PROBE_CERT_SHA256",
  ]) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
})

function appRequest(headers: HeadersInit = {}) {
  return new Request("https://app.lyrashieldai.com/billing/checkout", { headers })
}

function candidateRequest(headers: HeadersInit = {}) {
  return new Request(
    "https://lyrashield-app--candidate.icyglacier-d3526777.centralindia.azurecontainerapps.io/api/ready",
    { headers }
  )
}

describe("app Cloudflare origin trust", () => {
  it("requires exact XFCC certificate fingerprint when mTLS is required", async () => {
    process.env.CLOUDFLARE_ORIGIN_MTLS = "required"
    process.env.CLOUDFLARE_AOP_CERT_SHA256 = fingerprint
    process.env.DEPLOY_PROBE_CERT_SHA256 = "f".repeat(64)
    expect(
      await assessAppOrigin(
        appRequest({ "x-forwarded-client-cert": `Cert="${certificate.replace(/\n/g, "\\n")}"` })
      )
    ).toBe("cloudflare")
    expect(
      await assessAppOrigin(
        appRequest({
          "x-forwarded-client-cert":
            'Cert="-----BEGIN CERTIFICATE-----\\nBQ==\\n-----END CERTIFICATE-----"',
        })
      )
    ).toBe("untrusted")
    expect(await assessAppOrigin(appRequest())).toBe("untrusted")
  })

  it("uses Azure's exact forwarded client-certificate hash when available", async () => {
    process.env.CLOUDFLARE_ORIGIN_MTLS = "required"
    process.env.CLOUDFLARE_AOP_CERT_SHA256 = fingerprint
    process.env.DEPLOY_PROBE_CERT_SHA256 = "f".repeat(64)

    expect(
      await assessAppOrigin(
        appRequest({ "x-forwarded-client-cert": `Hash=${fingerprint};Cert="not-a-certificate"` })
      )
    ).toBe("cloudflare")
    expect(
      await assessAppOrigin(
        appRequest({
          "x-forwarded-client-cert": `Hash=${fingerprint};Hash=${"e".repeat(64)}`,
        })
      )
    ).toBe("untrusted")
  })

  it("accepts the exact deploy probe certificate on a direct candidate host", async () => {
    process.env.CLOUDFLARE_ORIGIN_MTLS = "required"
    process.env.CLOUDFLARE_AOP_CERT_SHA256 = "f".repeat(64)
    process.env.DEPLOY_PROBE_CERT_SHA256 = fingerprint

    expect(
      await assessAppOrigin(
        candidateRequest({
          "x-forwarded-client-cert": `Hash=${fingerprint};Cert="not-a-certificate"`,
        })
      )
    ).toBe("probe")
  })

  it("does not impose app-origin trust on another hostname", async () => {
    expect(isAppHost(new Request("https://scanner.lyrashieldai.com"))).toBe(false)
    expect(await assessAppOrigin(new Request("https://scanner.lyrashieldai.com"))).toBe("off")
  })

  it("accepts only a normalized Cloudflare country", () => {
    expect(trustedAppCountry(appRequest({ "cf-ipcountry": "in" }))).toBe("IN")
    expect(trustedAppCountry(appRequest({ "cf-ipcountry": "T1" }))).toBe(null)
  })

  it("does not require a certificate before edge cutover", async () => {
    process.env.CLOUDFLARE_ORIGIN_MTLS = "off"
    expect(await assessAppOrigin(appRequest({ "cf-ipcountry": "IN" }))).toBe("off")
  })
})
