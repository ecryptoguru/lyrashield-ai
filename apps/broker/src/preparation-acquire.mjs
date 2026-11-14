// Fixed root host entrypoint in the qualified read-only broker image. No caller paths or commands.
const deadline = setTimeout(() => process.exit(1), 45_000)
try {
  if (process.platform !== "linux" || process.getuid() !== 0)
    throw new Error("Root acquisition unavailable")
  const chunks = []
  let length = 0
  for await (const chunk of process.stdin) {
    length += chunk.length
    if (length > 128 * 1024) throw new Error("Acquisition request exceeds bound")
    chunks.push(chunk)
  }
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (
    Object.keys(request).sort().join(",") !== "environment,source" ||
    !request.environment ||
    typeof request.environment !== "object"
  )
    throw new Error("Acquisition request unavailable")
  const allowed = new Set([
    "NODE_ENV",
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "PLATFORM_ADMIN_EMAILS",
    "TRUSTED_PROXY_IP_HEADER",
    "IP_HASH_SALT",
    "LYRASHIELD_REQUIRE_EMAIL_VERIFICATION",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_BUCKET",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "LYRASHIELD_EVIDENCE_KEK",
    "LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF",
    "LYRASHIELD_EVIDENCE_KEK_KEYRING",
  ])
  for (const [name, value] of Object.entries(request.environment)) {
    if (
      !allowed.has(name) ||
      typeof value !== "string" ||
      value.length > 16384 ||
      value.includes("\0")
    )
      throw new Error("Acquisition environment unavailable")
  }
  if (
    request.environment.NODE_ENV !== "production" ||
    request.environment.LYRASHIELD_REQUIRE_EMAIL_VERIFICATION !== "0"
  )
    throw new Error("Acquisition production configuration unavailable")
  // Set only this fixed configuration before importing SDKs whose shared config is captured at import.
  for (const name of Object.keys(process.env)) delete process.env[name]
  Object.assign(process.env, request.environment, {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/nonexistent",
    TSX_DISABLE_CACHE: "1",
  })
  const { acquirePreparationArtifacts } = await import("./preparation-acquisition.ts")
  const result = await acquirePreparationArtifacts(request.source)
  const raw = JSON.stringify(result)
  if (Buffer.byteLength(raw) > 8 * 1024 * 1024)
    throw new Error("Acquisition response exceeds bound")
  process.stdout.write(raw)
} catch {
  process.exitCode = 1
} finally {
  clearTimeout(deadline)
}
