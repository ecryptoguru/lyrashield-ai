import { createInterface } from "node:readline"
import { Writable } from "node:stream"
import minimist from "minimist"
import { saveCredentials, loadCredentials, getEnvApiUrl } from "../credentials.js"
import { redactKey } from "../output.js"
import type { Output } from "../output.js"
import process from "node:process"
import { randomUUID } from "node:crypto"

async function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const noOp = new Writable({ write() {} })
    const rl = createInterface({ input: process.stdin, output: noOp, terminal: true })
    process.stderr.write(prompt)
    rl.question("", (answer) => {
      rl.close()
      resolve(answer)
    })
    rl.on("error", reject)
  })
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString("utf-8").trim()
}

async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  try {
    const { spawn } = await import("node:child_process")
    spawn(command, [url], { detached: true, stdio: "ignore" }).unref()
  } catch {
    // Printing the URL below is the reliable fallback for headless/locked-down shells.
  }
}

async function loginWithDevice(apiUrl: string, output: Output): Promise<number> {
  const clientId = "lyrashield-cli"
  const codeResponse = await fetch(`${apiUrl.replace(/\/$/, "")}/api/auth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      scope: "openid profile email offline_access lyrashield.read",
    }),
  })
  const code = (await codeResponse.json().catch(() => null)) as {
    device_code?: string
    user_code?: string
    verification_uri?: string
    verification_uri_complete?: string
    interval?: number
    expires_in?: number
    error?: string
    error_description?: string
  } | null
  if (!codeResponse.ok || !code?.device_code || !code.user_code || !code.verification_uri) {
    output.error(code?.error_description ?? "OAuth device authorization could not be started.")
    return 4
  }

  const verificationUrl =
    code.verification_uri_complete ??
    `${code.verification_uri}?user_code=${encodeURIComponent(code.user_code)}`
  output.log(`Open ${verificationUrl} and approve the LyraShield connection.`)
  await openBrowser(verificationUrl)

  let interval = Math.max(5, code.interval ?? 5)
  const deadline = Date.now() + Math.min((code.expires_in ?? 1800) * 1000, 30 * 60 * 1000)
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000))
    const tokenResponse = await fetch(`${apiUrl.replace(/\/$/, "")}/api/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: clientId,
      }),
    })
    const token = (await tokenResponse.json().catch(() => null)) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      error?: string
      error_description?: string
    } | null
    if (token?.access_token) {
      const existing = (await loadCredentials()) ?? { installId: randomUUID() }
      await saveCredentials({
        ...existing,
        apiKey: undefined,
        oauthAccessToken: token.access_token,
        oauthRefreshToken: token.refresh_token,
        oauthExpiresAt: token.expires_in
          ? new Date(Date.now() + token.expires_in * 1000).toISOString()
          : undefined,
        apiUrl,
      })
      output.log(
        "Logged in with OAuth. The connection is read-only until a client requests write access and you approve it."
      )
      return 0
    }
    if (token?.error === "authorization_pending") continue
    if (token?.error === "slow_down") {
      interval += 5
      continue
    }
    output.error(token?.error_description ?? "OAuth device authorization was denied or expired.")
    return 4
  }
  output.error("OAuth device authorization timed out. Run `lyrashield login --oauth` to try again.")
  return 4
}

export async function handleLogin(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    string: ["key", "url", "workspace"],
    boolean: ["oauth"],
    alias: { k: "key" },
    default: { url: getEnvApiUrl() ?? "https://app.lyrashieldai.com" },
  })

  if (parsed.oauth) return loginWithDevice(parsed.url, output)

  let key = parsed.key
  if (!key) {
    if (!process.stdin.isTTY) {
      key = await readStdin()
    } else {
      key = await promptHidden("Paste API key (input hidden): ")
    }
  }

  key = key?.trim()
  if (!key) {
    output.error("API key required. Pipe it to stdin or use --key.")
    return 2
  }

  if (!key.startsWith("lsk_")) {
    output.warn("Key does not start with lsk_. It may not be a LyraShield API key.")
  }

  const existing = (await loadCredentials()) ?? { installId: randomUUID() }
  await saveCredentials({
    ...existing,
    apiKey: key,
    apiUrl: parsed.url,
    workspaceId: parsed.workspace ?? existing.workspaceId,
  })

  output.log(`Logged in as ${redactKey(key)}`)
  output.notice("Never share your API key or commit it to a repository.")
  return 0
}
