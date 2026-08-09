export function serializeOAuthQuery(params: Record<string, string | string[] | undefined>) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, Array.isArray(value) ? (value[0] ?? "") : value)
  }
  return query.toString()
}
