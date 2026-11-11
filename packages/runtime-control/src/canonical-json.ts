import { createHash } from "node:crypto"

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    const normalized: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(record).sort()) normalized[key] = normalize(record[key])
    return normalized
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}
