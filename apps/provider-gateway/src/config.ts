import { requestPolicySchema, type RequestPolicy } from "./request-policy"

export interface ProviderRoute {
  id: string
  baseUrl: string
  auth:
    | { kind: "authorization"; credential: string }
    | { kind: "api-key"; credential: string; headerName: string }
  allowedPathPrefixes: string[]
  requestPolicy?: RequestPolicy
}

export interface ProviderGatewayConfig {
  socketPath?: string
  host: string
  port: number
  journalPath: string
  signingSecret: string
  responseEncryptionSecret: string
  controlToken: string
  admission: "closed" | "open"
  providers: Map<string, ProviderRoute>
}

interface RouteDescriptor {
  id: string
  baseUrl: string
  authKind: "authorization" | "api-key"
  secretEnv: string
  headerName?: string
  allowedPathPrefixes: string[]
  requestPolicy?: unknown
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function parseRoutes(raw: string, env: NodeJS.ProcessEnv): Map<string, ProviderRoute> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error("LYRASHIELD_PROVIDER_ROUTES_JSON must be valid JSON")
  }
  if (!Array.isArray(value)) throw new Error("LYRASHIELD_PROVIDER_ROUTES_JSON must be an array")
  const providers = new Map<string, ProviderRoute>()
  for (const entry of value) {
    if (entry === null || typeof entry !== "object")
      throw new Error("provider route must be an object")
    const descriptor: RouteDescriptor = entry
    if (
      typeof descriptor.id !== "string" ||
      !/^[a-z][a-z0-9-]{1,63}$/.test(descriptor.id) ||
      typeof descriptor.baseUrl !== "string" ||
      !["authorization", "api-key"].includes(descriptor.authKind) ||
      typeof descriptor.secretEnv !== "string" ||
      !Array.isArray(descriptor.allowedPathPrefixes) ||
      !descriptor.allowedPathPrefixes.every(
        (prefix) => typeof prefix === "string" && prefix.startsWith("/") && !prefix.includes("..")
      )
    ) {
      throw new Error(`invalid provider route descriptor for ${String(descriptor.id)}`)
    }
    const base = new URL(descriptor.baseUrl)
    if (base.username || base.password || base.hash || base.search)
      throw new Error("provider base URL must not contain credentials, a query or a fragment")
    if (
      base.protocol !== "https:" &&
      !(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname))
    ) {
      throw new Error("provider routes require HTTPS except for local synthetic upstreams")
    }
    if (providers.has(descriptor.id)) throw new Error(`duplicate provider route ${descriptor.id}`)
    const credential = env[descriptor.secretEnv]?.trim()
    if (!credential) throw new Error(`provider credential ${descriptor.secretEnv} is missing`)
    const auth =
      descriptor.authKind === "authorization"
        ? { kind: "authorization" as const, credential }
        : {
            kind: "api-key" as const,
            credential,
            headerName:
              descriptor.headerName && /^[A-Za-z0-9-]{1,64}$/.test(descriptor.headerName)
                ? descriptor.headerName.toLowerCase()
                : "api-key",
          }
    providers.set(descriptor.id, {
      id: descriptor.id,
      baseUrl: base.toString(),
      auth,
      allowedPathPrefixes: descriptor.allowedPathPrefixes,
      ...(descriptor.requestPolicy !== undefined
        ? { requestPolicy: requestPolicySchema.parse(descriptor.requestPolicy) }
        : {}),
    })
  }
  return providers
}

export function loadProviderGatewayConfig(
  env: NodeJS.ProcessEnv = process.env
): ProviderGatewayConfig {
  const admission = env.LYRASHIELD_RUNTIME_ADMISSION?.trim() || "closed"
  if (admission !== "closed" && admission !== "open") {
    throw new Error("LYRASHIELD_RUNTIME_ADMISSION must be closed or open")
  }
  if (admission === "open") {
    throw new Error(
      "Provider admission is held until broker and journal qualification is installed"
    )
  }
  const port = Number(env.LYRASHIELD_PROVIDER_GATEWAY_PORT ?? "8791")
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("invalid provider gateway port")
  return {
    socketPath: env.LYRASHIELD_PROVIDER_GATEWAY_SOCKET_PATH?.trim() || undefined,
    host: env.LYRASHIELD_PROVIDER_GATEWAY_HOST?.trim() || "127.0.0.1",
    port,
    journalPath: required(env, "LYRASHIELD_PROVIDER_GATEWAY_JOURNAL_PATH"),
    signingSecret: required(env, "LYRASHIELD_PROVIDER_GATEWAY_SIGNING_SECRET"),
    responseEncryptionSecret: required(
      env,
      "LYRASHIELD_PROVIDER_GATEWAY_RESPONSE_ENCRYPTION_SECRET"
    ),
    controlToken: required(env, "LYRASHIELD_PROVIDER_GATEWAY_CONTROL_TOKEN"),
    admission,
    providers: parseRoutes(required(env, "LYRASHIELD_PROVIDER_ROUTES_JSON"), env),
  }
}
