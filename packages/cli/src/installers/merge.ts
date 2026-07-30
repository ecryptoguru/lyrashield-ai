import { chmod } from "node:fs/promises"
import { mergeJson, removeJson } from "./json.js"
import { mergeJsonc, removeJsonc } from "./jsonc.js"
import { mergeToml, removeToml } from "./toml.js"
import { mergeYaml, removeYaml } from "./yaml.js"
import type { ConfigFormat } from "@lyrashield/agent-registry"

export interface MergeFileOptions {
  filePath: string
  format: ConfigFormat
  rootKey: string
  serverName: string
  value: unknown
  dryRun?: boolean
  chmod0600?: boolean
}

export interface MergeFileResult {
  changed: boolean
  backupPath?: string
}

export async function mergeFile(opts: MergeFileOptions): Promise<MergeFileResult> {
  const { format } = opts
  const common = { ...opts }
  let result: MergeFileResult
  if (format === "json") result = await mergeJson(common)
  else if (format === "jsonc") result = await mergeJsonc(common)
  else if (format === "toml") result = await mergeToml(common)
  else if (format === "yaml") result = await mergeYaml(common)
  else throw new Error(`Unsupported config format: ${format}`)

  if (result.changed && opts.chmod0600 && !opts.dryRun) {
    try {
      await chmod(opts.filePath, 0o600)
    } catch {
      // ignore
    }
  }
  return result
}

export async function removeFile(opts: {
  filePath: string
  format: ConfigFormat
  rootKey: string
  serverName: string
}): Promise<boolean> {
  const { format } = opts
  if (format === "json") return removeJson(opts)
  if (format === "jsonc") return removeJsonc(opts)
  if (format === "toml") return removeToml(opts)
  if (format === "yaml") return removeYaml(opts)
  throw new Error(`Unsupported config format: ${format}`)
}
