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
