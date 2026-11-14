import { readBoundedResponseText } from "@lyrashield/runtime-control"
import {
  providerGrantRequestSchema,
  providerGrantSchema,
  providerGrantStatusSchema,
  type ProviderGrant,
  type ProviderGrantRequest,
  type ProviderGrantRevocation,
  type ProviderGrantStatus,
  type SupervisorPort,
} from "@lyrashield/runtime-control"

const REQUEST_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 256 * 1024

export class ProviderGatewayClient implements SupervisorPort {
  constructor(
    private readonly baseUrl: string,
    private readonly controlToken: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    const parsed = new URL(baseUrl)
    // The control token travels as a bearer credential: refuse to send it to
    // a remote cleartext endpoint. Plain HTTP is a loopback test posture only.
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
      throw new Error("provider gateway URL must use HTTPS outside a local control-plane test")
    }
  }

  issueGrant(request: ProviderGrantRequest): Promise<ProviderGrant> {
    return this.jsonRequest("/v1/grants", {
      method: "POST",
      body: providerGrantRequestSchema.parse(request),
    }).then((value) => providerGrantSchema.parse(value))
  }

  findGrantByRequest(grantRequestId: string): Promise<ProviderGrant | null> {
    return this.jsonRequest(`/v1/grants/request/${encodeURIComponent(grantRequestId)}`, {
      method: "GET",
    }).then((value) => {
      if (value === null) return null
      return providerGrantSchema.parse(value)
    })
  }

  revokeGrant(request: ProviderGrantRevocation): Promise<ProviderGrantStatus> {
    return this.jsonRequest(`/v1/grants/${encodeURIComponent(request.grantId)}/revoke`, {
      method: "POST",
      body: request,
    }).then((value) => providerGrantStatusSchema.parse(value))
  }

  inspectGrant(grantId: string): Promise<ProviderGrantStatus | null> {
    return this.jsonRequest(`/v1/grants/${encodeURIComponent(grantId)}`, { method: "GET" }).then(
      (value) => {
        if (value === null) return null
        return providerGrantStatusSchema.parse(value)
      }
    )
  }

  private async jsonRequest(
    path: string,
    options: { method: "GET" | "POST"; body?: unknown }
  ): Promise<unknown> {
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method: options.method,
      headers: {
        authorization: `Bearer ${this.controlToken}`,
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    })
    const raw = await readBoundedResponseText(response, MAX_RESPONSE_BYTES, "provider gateway")
    let value: unknown = null
    if (raw) {
      try {
        value = JSON.parse(raw)
      } catch {
        throw new Error("provider gateway returned invalid JSON")
      }
    }
    if (!response.ok) {
      const code =
        value !== null &&
        typeof value === "object" &&
        "code" in value &&
        typeof value.code === "string"
          ? value.code
          : `HTTP_${response.status}`
      throw new Error(`provider gateway rejected the operation: ${code}`)
    }
    return value
  }
}
