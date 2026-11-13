import type { ExecutorSpec } from "@lyrashield/runtime-control"
import type { ExecutorContext } from "./executor"
import { assertSpecHasNoAmbientCredentials } from "./policy"

const dockerClientEnvironment = [
  "PATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "XDG_RUNTIME_DIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "TMPDIR",
] as const

/** Prepare a scan-bound gateway grant without placing it in the Docker CLI arguments. */
export function providerEnvironment(spec: ExecutorSpec, context: ExecutorContext) {
  const provider = context.provider
  if (!provider) return { args: [] as string[], env: undefined }
  assertSpecHasNoAmbientCredentials(spec)
  let url: URL
  try {
    url = new URL(provider.gatewayUrl)
  } catch {
    throw new Error("invalid scan-bound provider gateway configuration")
  }
  if (
    spec.grantEnvName !== "LLM_API_KEY" ||
    Object.hasOwn(spec.env, "LLM_API_KEY") ||
    !["http:", "https:"].includes(url.protocol) ||
    (url.protocol === "http:" && !["127.0.0.1", "[::1]"].includes(url.hostname)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !/^[a-z][a-z0-9-]{1,63}$/.test(provider.providerId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/.test(provider.scanId) ||
    provider.scanId.includes("..") ||
    !/^[A-Za-z0-9._~-]{32,8192}$/.test(provider.token)
  )
    throw new Error("invalid scan-bound provider gateway configuration")
  const env: NodeJS.ProcessEnv = {}
  for (const name of dockerClientEnvironment) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  env.LLM_API_KEY = provider.token
  return {
    args: [
      "--env",
      "LLM_API_KEY",
      "--env",
      `LLM_API_BASE=${url.origin}/v1/provider/${provider.providerId}`,
      "--env",
      `LYRASHIELD_PROVIDER_GATEWAY_ORIGIN=${url.origin}`,
      "--env",
      `STRIX_RUN_ID=${provider.scanId}`,
    ],
    env,
  }
}
