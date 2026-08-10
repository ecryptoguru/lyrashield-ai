import { describe, it, expect, vi, beforeEach } from "vitest"
import { scanOpenApi } from "./openapi-scanner"
import { getUrlScanProfile } from "@lyrashield/types"

const PUBLIC_RESOLVER = vi.fn().mockResolvedValue(["1.2.3.4"])

function makeSpecResponse(body: string, contentType = "application/json") {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(Buffer.byteLength(body, "utf8")),
    },
  })
}

function defaultFetch(responses: Record<string, Response>) {
  return vi.fn(async (url: string, _init: RequestInit) => {
    const res = responses[url]
    if (res) return res
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })
}

const standardSpec = {
  openapi: "3.0.0",
  servers: [{ url: "https://api.example.com/" }],
  paths: {
    "/health": {
      get: {
        operationId: "getHealth",
        responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } },
      },
      head: { responses: { "200": { description: "OK" } } },
      post: { summary: "admin reset" },
    },
    "/about": {
      get: {
        operationId: "getAbout",
        responses: { "200": { description: "OK", content: { "text/plain": { schema: { type: "string" } } } } },
      },
      head: { responses: { "200": { description: "OK" } } },
    },
    "/private": {
      get: {
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "OK" } },
      },
    },
    "/off-origin": {
      get: {
        responses: { "200": { description: "OK" } },
      },
      servers: [{ url: "https://outside.example/api" }],
    },
    "/malformed": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { allOf: [{ type: "object" }] } } },
          },
        },
      },
      head: { responses: { "200": { description: "OK" } } },
    },
  },
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
  },
}

const deepSpec = {
  openapi: "3.0.0",
  servers: [{ url: "https://api.example.com/" }],
  paths: {
    "/health": {
      get: {
        operationId: "getHealth",
        responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } },
      },
      head: { responses: { "200": { description: "OK" } } },
      options: { responses: { "204": { description: "CORS" } } },
    },
    "/users/{id}": {
      get: {
        operationId: "getUser",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "integer" },
            example: 42,
          },
          {
            name: "expand",
            in: "query",
            schema: { type: "string", enum: ["profile"] },
          },
        ],
        responses: { "200": { description: "OK" } },
      },
    },
    "/secret/{token}": {
      get: {
        parameters: [
          {
            name: "token",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: { "200": { description: "OK" } },
      },
    },
  },
}

const specWithTooManyPaths = {
  openapi: "3.0.0",
  paths: Object.fromEntries(
    Array.from({ length: 501 }, (_, i) => [`/path-${i}`, { get: { responses: { "200": { description: "OK" } } } }])
  ),
}

function corsResponse(url: string, method: string) {
  const baseHeaders: Record<string, string> = { "content-type": "application/json" }
  if (method === "GET") {
    baseHeaders["access-control-allow-origin"] = "https://lyrashield.invalid"
    baseHeaders["access-control-allow-credentials"] = "true"
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: baseHeaders })
}

describe("scanOpenApi", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("fetches a JSON spec and emits GET + HEAD operation attempts for Standard", async () => {
    const apiSpecUrl = "https://api.example.com/openapi.json"
    const spec = standardSpec
    const fetchFn = defaultFetch({
      [apiSpecUrl]: makeSpecResponse(JSON.stringify(spec)),
    })

    const result = await scanOpenApi({
      targetUrl: "https://api.example.com",
      apiSpecUrl,
      profile: getUrlScanProfile("API", "STANDARD"),
      fetchFn,
      resolver: PUBLIC_RESOLVER,
    })

    expect(result.attemptedOperations.map((o) => o.method)).toEqual(["GET", "HEAD", "GET", "HEAD", "GET", "HEAD", "GET", "HEAD", "GET", "HEAD"])
    expect(result.attemptedOperations).toHaveLength(10)
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "AUTHENTICATION_REQUIRED", subject: expect.stringContaining("/private") })
    )
    expect(fetchFn).not.toHaveBeenCalledWith(
      expect.stringContaining("outside.example"),
      expect.anything()
    )
  })

  it("parses YAML specs and fills documented path values for Deep", async () => {
    const apiSpecUrl = "https://api.example.com/openapi.yaml"
    const yaml = require("yaml")
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      if (url === apiSpecUrl) {
        return new Response(yaml.stringify(deepSpec), {
          status: 200,
          headers: { "content-type": "application/yaml" },
        })
      }
      return corsResponse(url, init.method as string)
    })

    const result = await scanOpenApi({
      targetUrl: "https://api.example.com",
      apiSpecUrl,
      profile: getUrlScanProfile("API", "DEEP"),
      fetchFn,
      resolver: PUBLIC_RESOLVER,
    })

    const ops = result.attemptedOperations
    expect(ops.length).toBeGreaterThanOrEqual(4)
    expect(ops.some((o) => o.method === "GET" && o.path === "/users/{id}" && o.url === "https://api.example.com/users/42")).toBe(true)
    expect(ops.some((o) => o.method === "OPTIONS")).toBe(true)
    expect(ops.every((o) => ["GET", "HEAD", "OPTIONS"].includes(o.method))).toBe(true)
  })

  it("rejects a spec with more than 500 paths", async () => {
    const apiSpecUrl = "https://api.example.com/openapi.json"
    const fetchFn = defaultFetch({
      [apiSpecUrl]: makeSpecResponse(JSON.stringify(specWithTooManyPaths)),
    })

    const result = await scanOpenApi({
      targetUrl: "https://api.example.com",
      apiSpecUrl,
      profile: getUrlScanProfile("API", "STANDARD"),
      fetchFn,
      resolver: PUBLIC_RESOLVER,
    })

    expect(result.attemptedOperations).toHaveLength(0)
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "UNSUPPORTED_CONTENT" })
    )
  })

  it("skips operations whose server is off-origin", async () => {
    const apiSpecUrl = "https://api.example.com/openapi.json"
    const spec = {
      openapi: "3.0.0",
      servers: [{ url: "https://outside.example/" }],
      paths: { "/health": { get: { responses: { "200": { description: "OK" } } } } },
    }
    const fetchFn = defaultFetch({ [apiSpecUrl]: makeSpecResponse(JSON.stringify(spec)) })

    const result = await scanOpenApi({
      targetUrl: "https://api.example.com",
      apiSpecUrl,
      profile: getUrlScanProfile("API", "STANDARD"),
      fetchFn,
      resolver: PUBLIC_RESOLVER,
    })

    expect(result.attemptedOperations).toHaveLength(0)
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "OUT_OF_SCOPE" })
    )
  })

  it("records SCHEMA_UNSUPPORTED for non-scalar response schemas", async () => {
    const apiSpecUrl = "https://api.example.com/openapi.json"
    const fetchFn = defaultFetch({
      [apiSpecUrl]: makeSpecResponse(JSON.stringify(standardSpec)),
      "https://api.example.com/malformed": new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    })

    const result = await scanOpenApi({
      targetUrl: "https://api.example.com",
      apiSpecUrl,
      profile: getUrlScanProfile("API", "STANDARD"),
      fetchFn,
      resolver: PUBLIC_RESOLVER,
    })

    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_UNSUPPORTED", subject: expect.stringContaining("/malformed") })
    )
  })

  it("skips operations with header, cookie, or secret-like parameters", async () => {
    const apiSpecUrl = "https://api.example.com/openapi.json"
    const spec = {
      openapi: "3.0.0",
      servers: [{ url: "https://api.example.com/" }],
      paths: {
        "/ok": { get: { responses: { "200": { description: "OK" } } } },
        "/sensitive": {
          get: {
            parameters: [{ name: "Authorization", in: "header", required: true }],
            responses: { "200": { description: "OK" } },
          },
        },
        "/cookie": {
          get: {
            parameters: [{ name: "session", in: "cookie", required: true }],
            responses: { "200": { description: "OK" } },
          },
        },
      },
    }
    const fetchFn = defaultFetch({ [apiSpecUrl]: makeSpecResponse(JSON.stringify(spec)) })

    const result = await scanOpenApi({
      targetUrl: "https://api.example.com",
      apiSpecUrl,
      profile: getUrlScanProfile("API", "STANDARD"),
      fetchFn,
      resolver: PUBLIC_RESOLVER,
    })

    expect(result.attemptedOperations.map((o) => o.path)).toEqual(["/ok", "/ok"])
    expect(result.attemptedOperations.map((o) => o.method)).toEqual(["GET", "HEAD"])
  })

  it("records a CORS reflected-origin signal in Deep mode", async () => {
    const apiSpecUrl = "https://api.example.com/openapi.json"
    const spec = {
      openapi: "3.0.0",
      servers: [{ url: "https://api.example.com/" }],
      paths: {
        "/health": {
          get: {
            responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } },
          },
        },
      },
    }
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      if (url === apiSpecUrl) return makeSpecResponse(JSON.stringify(spec))
      const headers: Record<string, string> = { "content-type": "application/json" }
      if (init.method === "GET") {
        headers["access-control-allow-origin"] = "https://lyrashield.invalid"
        headers["access-control-allow-credentials"] = "true"
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
    })

    const result = await scanOpenApi({
      targetUrl: "https://api.example.com",
      apiSpecUrl,
      profile: getUrlScanProfile("API", "DEEP"),
      fetchFn,
      resolver: PUBLIC_RESOLVER,
    })

    expect(result.signals).toContainEqual(
      expect.objectContaining({
        id: expect.stringContaining("cors-reflected-credentials"),
        controlIds: [14],
      })
    )
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        title: expect.stringContaining("CORS"),
        control_ids: [14],
      })
    )
  })

  it("does not call fetchFn for POST/PUT/PATCH/DELETE operations", async () => {
    const apiSpecUrl = "https://api.example.com/openapi.json"
    const spec = {
      openapi: "3.0.0",
      servers: [{ url: "https://api.example.com/" }],
      paths: {
        "/admin": {
          post: { responses: { "200": { description: "OK" } } },
          put: { responses: { "200": { description: "OK" } } },
          delete: { responses: { "200": { description: "OK" } } },
        },
      },
    }
    const fetchFn = defaultFetch({ [apiSpecUrl]: makeSpecResponse(JSON.stringify(spec)) })

    const result = await scanOpenApi({
      targetUrl: "https://api.example.com",
      apiSpecUrl,
      profile: getUrlScanProfile("API", "DEEP"),
      fetchFn,
      resolver: PUBLIC_RESOLVER,
    })

    const unsafeCalls = fetchFn.mock.calls.filter(([, init]: [string, RequestInit]) =>
      ["POST", "PUT", "PATCH", "DELETE"].includes(init.method as string)
    )
    expect(unsafeCalls).toHaveLength(0)
    expect(result.attemptedOperations).toHaveLength(0)
  })
})
