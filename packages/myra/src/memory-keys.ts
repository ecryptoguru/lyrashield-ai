/**
 * Allowlisted support-memory keys. The model can never write outside this
 * list, and memory never bears authority (no permissions, no confirmations).
 * Authenticated accounts only — anonymous memory stays client-side.
 */
export const MYRA_MEMORY_KEYS = [
  "preferred_timezone",
  "preferred_locale",
  "dismissed_flows",
  "preferred_depth", // terse | detailed answer style
] as const

export type MyraMemoryKey = (typeof MYRA_MEMORY_KEYS)[number]

const memoryValueValidators: Record<MyraMemoryKey, (v: unknown) => boolean> = {
  preferred_timezone: (v) => typeof v === "string" && v.length <= 60,
  preferred_locale: (v) => typeof v === "string" && v.length <= 20,
  dismissed_flows: (v) =>
    Array.isArray(v) && v.every((x) => typeof x === "string" && x.length <= 60) && v.length <= 50,
  preferred_depth: (v) => v === "terse" || v === "detailed",
}

export function isAllowedMemoryWrite(key: string, value: unknown): key is MyraMemoryKey {
  // hasOwn — a prototype key like "__proto__" must not resolve to a "validator".
  if (!Object.hasOwn(memoryValueValidators, key)) return false
  return memoryValueValidators[key as MyraMemoryKey](value)
}
