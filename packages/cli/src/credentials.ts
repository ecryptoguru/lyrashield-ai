/* eslint-disable security/detect-non-literal-fs-filename */
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile, unlink, chmod, access, rename } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export const CREDENTIALS_DIR = path.join(homedir(), ".lyrashield")
export const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, "credentials.json")

export interface Credentials {
  apiKey?: string
  apiUrl?: string
  workspaceId?: string
  installId: string
}

async function ensureDir(): Promise<void> {
  await mkdir(CREDENTIALS_DIR, { recursive: true, mode: 0o700 })
}

async function setFileMode(file: string, mode: number): Promise<void> {
  try {
    await chmod(file, mode)
  } catch {
    // ignore platforms without chmod semantics
  }
}

export async function loadCredentials(): Promise<Credentials | undefined> {
  try {
    const raw = await readFile(CREDENTIALS_FILE, "utf-8")
    const parsed = JSON.parse(raw) as Credentials
    if (!parsed.installId) parsed.installId = randomUUID()
    return parsed
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return undefined
    }
    throw new Error(`Could not read credentials: ${err}`)
  }
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  await ensureDir()
  const withId: Credentials = { ...credentials, installId: credentials.installId || randomUUID() }
  const tmp = `${CREDENTIALS_FILE}.tmp`
  await writeFile(tmp, JSON.stringify(withId, null, 2), { mode: 0o600 })
  await setFileMode(tmp, 0o600)
  await rename(tmp, CREDENTIALS_FILE)
}

export async function removeCredentials(): Promise<void> {
  try {
    await unlink(CREDENTIALS_FILE)
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return
    throw err
  }
}

export async function credentialsFileExists(): Promise<boolean> {
  try {
    await access(CREDENTIALS_FILE)
    return true
  } catch {
    return false
  }
}

export function getEnvApiKey(): string | undefined {
  return process.env.LYRASHIELD_API_KEY
}

export function getEnvApiUrl(): string | undefined {
  return process.env.LYRASHIELD_API_URL
}

export interface EffectiveCredentials {
  apiKey: string | undefined
  apiUrl: string
  workspaceId: string | undefined
  installId: string | undefined
  source: "env" | "file" | "none"
}

export async function getEffectiveCredentials(): Promise<EffectiveCredentials> {
  const envKey = getEnvApiKey()
  const envUrl = getEnvApiUrl()
  const stored = await loadCredentials()
  const apiKey = envKey ?? stored?.apiKey
  const apiUrl = envUrl ?? stored?.apiUrl ?? "https://app.lyrashieldai.com"
  const source: "env" | "file" | "none" = envKey || envUrl ? "env" : stored ? "file" : "none"
  return {
    apiKey,
    apiUrl,
    workspaceId: stored?.workspaceId,
    installId: stored?.installId,
    source,
  }
}

export function requireApiKey(creds: EffectiveCredentials): string {
  if (!creds.apiKey) throw new Error("No API key. Run: lyrashield login")
  return creds.apiKey
}

export function requireWorkspace(creds: EffectiveCredentials): string {
  if (!creds.workspaceId) throw new Error("No workspace set. Run: lyrashield use <workspace>")
  return creds.workspaceId
}
