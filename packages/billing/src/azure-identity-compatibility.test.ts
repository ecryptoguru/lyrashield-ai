import { createRequire } from "node:module"
import { afterEach, expect, it, vi } from "vitest"

// Exercise the installed SDK rather than mocking MSAL: the security override
// crosses MSAL majors, while production signing relies on managed identity.
const require = createRequire(import.meta.url)
const { DefaultAzureCredential } = require("@azure/identity") as typeof import("@azure/identity")
const identityRequire = createRequire(require.resolve("@azure/identity"))
const { createHttpHeaders } = identityRequire("@azure/core-rest-pipeline")

afterEach(() => vi.unstubAllEnvs())

it("keeps DefaultAzureCredential managed identity compatible with the patched MSAL", async () => {
  for (const key of Object.keys(process.env)) {
    if (/^(AZURE_|MSI_|IDENTITY_|IMDS_)/.test(key)) vi.stubEnv(key, undefined)
  }
  vi.stubEnv("IDENTITY_ENDPOINT", "http://127.0.0.1:1/identity")
  vi.stubEnv("IDENTITY_HEADER", "fixture-identity-header")
  const clientId = "11111111-1111-1111-1111-111111111111"
  const requests: { url: string; method: string; identityHeader?: string }[] = []
  const credential = new DefaultAzureCredential({
    managedIdentityClientId: clientId,
    retryOptions: { maxRetries: 0 },
    httpClient: {
      async sendRequest(request) {
        requests.push({
          url: request.url,
          method: request.method,
          identityHeader: request.headers.get("X-IDENTITY-HEADER"),
        })
        return {
          request,
          status: 200,
          headers: createHttpHeaders({ "content-type": "application/json" }),
          bodyAsText: JSON.stringify({
            access_token: "fixture-token",
            expires_on: String(Math.floor(Date.now() / 1000) + 3600),
            resource: "https://vault.azure.net",
            token_type: "Bearer",
          }),
        }
      },
    },
  })

  const token = await credential.getToken("https://vault.azure.net/.default")
  expect(token?.token).toBe("fixture-token")
  expect(requests).toHaveLength(1)
  const request = requests[0]!
  const url = new URL(request.url)
  expect(url.origin).toBe("http://127.0.0.1:1")
  expect(url.searchParams.get("resource")).toBe("https://vault.azure.net")
  expect(url.searchParams.get("client_id")).toBe(clientId)
  expect(request.method).toBe("GET")
  expect(request.identityHeader).toBe("fixture-identity-header")
})
