import { fileURLToPath } from "node:url"
import { normalizeBackupConnection } from "../../packages/db/scripts/webhook-backup-connection.mjs"

// The backup client strengthens legacy encryption-only URLs before connecting.
// Stored credentials and the shared runtime/maintenance parser remain unchanged.
export function prepareVerifiedBackupConnection(raw) {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 8192)
    throw new Error("backup database URL is missing or invalid")
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error("backup database URL is not a valid PostgreSQL URL")
  }
  const modes = url.searchParams.getAll("sslmode")
  if (modes.length !== 1 || !["require", "verify-full"].includes(modes[0]))
    throw new Error("backup database URL requires one explicit supported TLS mode")
  url.searchParams.set("sslmode", "verify-full")
  const verified = normalizeBackupConnection(url.href)
  const libpq = new URL(verified.url)
  // Prisma's schema selection is already constrained to public. pg_dump's
  // explicit public/app flags own selection; libpq does not accept schema.
  libpq.searchParams.delete("schema")
  // Fixed trusted system roots, never a URL-supplied trust path or CA fetched
  // from an unverified server. libpq rejects weaker modes with this setting.
  libpq.searchParams.set("sslrootcert", "system")
  // GSS encryption must not take precedence over the verified TLS contract.
  libpq.searchParams.set("gssencmode", "disable")
  return { ...verified, libpqUrl: libpq.href }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const prepared = prepareVerifiedBackupConnection(process.env.DATABASE_DIRECT_URL)
    const mode = process.argv[2]
    if (!new Set(["libpq-url", "identity"]).has(mode)) throw new Error("Invalid output mode")
    // libpq-url is consumed only by private shell command substitution; never
    // publish it as a job output, artifact or diagnostic.
    process.stdout.write(mode === "identity" ? prepared.identitySha256 : prepared.libpqUrl)
  } catch {
    process.stderr.write("Verified backup connection preparation failed.\n")
    process.exitCode = 1
  }
}
