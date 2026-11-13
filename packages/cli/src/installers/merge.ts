import { readFile } from "node:fs/promises"
import { atomicWrite } from "./atomic-write.js"
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
  const common = { ...opts, mode: opts.chmod0600 ? 0o600 : undefined }
  let result: MergeFileResult
  if (format === "json") result = await mergeJson(common)
  else if (format === "jsonc") result = await mergeJsonc(common)
  else if (format === "toml") result = await mergeToml(common)
  else if (format === "yaml") result = await mergeYaml(common)
  else throw new Error(`Unsupported config format: ${format}`)

  if (!result.changed && opts.chmod0600 && !opts.dryRun) {
    // An idempotent install can encounter a config written before private
    // modes were enforced. Rewrite unchanged content through the same atomic
    // path so the restrictive mode is applied before the replacement appears.
    // filePath is the resolved config target path chosen by the installer.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const current = await readFile(opts.filePath, "utf-8")
    await atomicWrite(opts.filePath, current, {
      expectedContent: current,
      mode: 0o600,
    })
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
