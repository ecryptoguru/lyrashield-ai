/* eslint-disable security/detect-non-literal-fs-filename */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export const CREDENTIALS_DIR = path.join(homedir(), ".lyrashield")
export const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, "credentials.json")

export interface Credentials {
  apiKey?: string
  apiUrl?: string
}

export class NoApiKeyError extends Error {
  constructor() {
    super(
      "LYRASHIELD_API_KEY is not set and no credentials file was found. Run `lyrashield login` or set LYRASHIELD_API_KEY."
    )
    this.name = "NoApiKeyError"
  }
}

async function loadCredentialsFile(): Promise<Credentials | undefined> {
  try {
    const raw = await readFile(CREDENTIALS_FILE, "utf-8")
    const parsed = JSON.parse(raw) as Credentials
    return {
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
      apiUrl: typeof parsed.apiUrl === "string" ? parsed.apiUrl : undefined,
    }
  } catch {
    return undefined
  }
}

export async function resolveMcpCredentials(): Promise<{ apiKey: string; apiUrl: string }> {
  const envKey = process.env.LYRASHIELD_API_KEY
  const envUrl = process.env.LYRASHIELD_API_URL
  const file = await loadCredentialsFile()

  const apiKey = envKey || file?.apiKey
  const apiUrl = envUrl || file?.apiUrl || "https://app.lyrashieldai.com"

  if (!apiKey) {
    throw new NoApiKeyError()
  }

  return { apiKey, apiUrl }
}
