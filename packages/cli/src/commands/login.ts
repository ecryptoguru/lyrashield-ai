import { createInterface } from "node:readline"
import { Writable } from "node:stream"
import minimist from "minimist"
import { saveCredentials, loadCredentials, getEnvApiKey, getEnvApiUrl } from "../credentials.js"
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

export async function handleLogin(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    string: ["key", "url", "workspace"],
    alias: { k: "key" },
    default: { url: getEnvApiUrl() ?? "https://app.lyrashieldai.com" },
  })

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
