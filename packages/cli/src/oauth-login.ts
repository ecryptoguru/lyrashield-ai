import { createServer } from "node:http"
import { z } from "zod"
import { randomUUID } from "node:crypto"
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { loadCredentials, saveCredentials } from "./credentials.js"
import type { Output } from "./output.js"

/** Reject unsolicited callbacks and issuer mix-ups before exchanging any code. */
export function validateOAuthCallback(url: URL, state: string, issuer: string): string {
  if (
    url.pathname !== "/callback" ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.get("state") !== state
  )
    throw new Error("Invalid authorization state")
  if (url.searchParams.getAll("iss").length !== 1 || url.searchParams.get("iss") !== issuer)
    throw new Error("Invalid authorization issuer")
  if (url.searchParams.has("error")) throw new Error("Authorization was declined")
  const code = url.searchParams.get("code")
  if (!code || url.searchParams.getAll("code").length !== 1)
    throw new Error("Missing authorization code")
  return code
}

/** Use the hosted consent flow so the CLI receives the same bound grant as desktop clients. */
export async function loginWithOAuth(
  apiUrl: string,
  output: Output,
  openBrowser: (url: string) => Promise<void>
): Promise<number> {
  let base: URL
  try {
    base = new URL(apiUrl)
    if (base.username || base.password || base.search || base.hash)
      throw new Error("Invalid API URL")
  } catch {
    output.error("Provide an API URL without credentials, query parameters, or fragments.")
    return 2
  }
  if (
    base.protocol !== "https:" &&
    !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
  ) {
    output.error("OAuth requires HTTPS, except for local development.")
    return 2
  }
  const serverUrl = new URL("/api/mcp", base).href
  const fetchFn: typeof fetch = (input, init) =>
    fetch(input, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    })
  const state = randomUUID()
  let discovery: OAuthDiscoveryState | undefined
  let client: OAuthClientInformationMixed | undefined
  let tokens: OAuthTokens | undefined
  let verifier = ""
  let resolveCode!: (code: string) => void
  let rejectCode!: (error: Error) => void
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  // A timeout or browser rejection can arrive while metadata discovery is running.
  void codePromise.catch(() => {})
  let consumed = false
  const listener = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store")
    response.setHeader("Content-Type", "text/plain; charset=utf-8")
    if (request.method !== "GET" || consumed) {
      response.writeHead(400).end("Invalid authorization callback.")
      return
    }
    let callbackUrl: URL | undefined
    try {
      const issuer = discovery?.authorizationServerMetadata?.issuer
      if (!issuer) throw new Error("Authorization issuer unavailable")
      callbackUrl = new URL(request.url ?? "/", "http://127.0.0.1")
      const code = validateOAuthCallback(callbackUrl, state, issuer)
      consumed = true
      resolveCode(code)
      response.end("Authorization received. Return to LyraShield CLI to confirm the connection.")
    } catch {
      if (
        callbackUrl?.pathname === "/callback" &&
        callbackUrl.searchParams.getAll("state").length === 1 &&
        callbackUrl.searchParams.get("state") === state &&
        callbackUrl.searchParams.get("iss") === discovery?.authorizationServerMetadata?.issuer &&
        callbackUrl.searchParams.has("error")
      ) {
        consumed = true
        rejectCode(new Error("Authorization declined"))
      }
      response
        .writeHead(400)
        .end("Invalid or declined authorization. Return to the CLI and reconnect.")
    }
  })
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject)
      listener.listen(0, "127.0.0.1", resolve)
    })
    const address = listener.address()
    if (!address || typeof address === "string") throw new Error("Callback listener unavailable")
    const redirectUrl = `http://127.0.0.1:${address.port}/callback`
    timeout = setTimeout(() => rejectCode(new Error("Authorization timed out")), 5 * 60 * 1000)
    const scope = "lyrashield.read lyrashield.write offline_access"
    const provider: OAuthClientProvider = {
      redirectUrl,
      clientMetadata: {
        client_name: "LyraShield CLI",
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope,
      },
      state: () => state,
      clientInformation: () => client,
      saveClientInformation: (value) => {
        client = value
      },
      tokens: () => tokens,
      saveTokens: (value) => {
        tokens = value
      },
      saveCodeVerifier: (value) => {
        verifier = value
      },
      codeVerifier: () => verifier,
      saveDiscoveryState: (value) => {
        discovery = value
      },
      discoveryState: () => discovery,
      redirectToAuthorization: async (url) => {
        output.log(`Connect LyraShield once in your browser: ${url.href}`)
        await openBrowser(url.href)
      },
    }
    if ((await auth(provider, { serverUrl, scope, fetchFn })) !== "REDIRECT")
      throw new Error("Authorization did not start")
    const code = await codePromise
    if (
      (await auth(provider, { serverUrl, authorizationCode: code, scope, fetchFn })) !==
        "AUTHORIZED" ||
      !tokens ||
      !client
    )
      throw new Error("Authorization did not complete")
    const grantedTokens = tokens as OAuthTokens
    const registeredClient = client as OAuthClientInformationMixed
    const workspacesResponse = await fetchFn(new URL("/api/workspaces", base), {
      headers: { Authorization: `Bearer ${grantedTokens.access_token}` },
      redirect: "error",
    })
    const workspaces = z
      .object({ data: z.array(z.object({ id: z.string().min(1) })).length(1) })
      .safeParse(await workspacesResponse.json())
    if (!workspacesResponse.ok || !workspaces.success)
      throw new Error("The authorized workspace could not be established")
    const existing = (await loadCredentials()) ?? { installId: randomUUID() }
    await saveCredentials({
      ...existing,
      apiKey: undefined,
      apiUrl: base.origin,
      oauthAccessToken: grantedTokens.access_token,
      oauthRefreshToken: grantedTokens.refresh_token,
      oauthExpiresAt: grantedTokens.expires_in
        ? new Date(Date.now() + grantedTokens.expires_in * 1000).toISOString()
        : undefined,
      clientId: registeredClient.client_id,
      issuer: discovery?.authorizationServerMetadata?.issuer,
      resource: serverUrl,
      workspaceId: workspaces.data.data[0]!.id,
      connectionId: undefined,
    })
    output.log(
      "Connected. Authorized actions run automatically within your workspace permissions and budget."
    )
    return 0
  } catch {
    output.error(
      "OAuth connection did not complete. Run `lyrashield login --oauth` to reconnect; existing credentials were preserved."
    )
    return 4
  } finally {
    if (timeout) clearTimeout(timeout)
    listener.closeAllConnections()
    listener.close()
  }
}
