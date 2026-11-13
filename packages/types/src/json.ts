import type { z } from "zod"

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseJson<T extends z.ZodType>(text: string, schema: T): z.output<T> {
  const value: unknown = JSON.parse(text)
  return schema.parse(value)
}

export function parseJsonColumn<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  return schema.parse(value)
}

/** Sorted-key serialization for the existing evidence checksum contracts. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`
}
