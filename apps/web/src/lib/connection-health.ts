export function connectionHealth(
  connection: { status: string; scopes: string[]; expiresAt: string | Date | null },
  now = Date.now()
) {
  const expired = connection.expiresAt !== null && new Date(connection.expiresAt).getTime() <= now
  const status =
    ["ACTIVE", "PAUSED"].includes(connection.status) && expired ? "EXPIRED" : connection.status
  const active = status === "ACTIVE"
  const reads = active && connection.scopes.includes("lyrashield.read")
  const writes = active && connection.scopes.includes("lyrashield.write")
  return {
    status,
    usability:
      reads && writes
        ? "Reads and writes available"
        : reads
          ? "Read-only access"
          : writes
            ? "Write access available"
            : "Access unavailable",
    reconnect: status === "EXPIRED" || status === "REVOKED",
  }
}
