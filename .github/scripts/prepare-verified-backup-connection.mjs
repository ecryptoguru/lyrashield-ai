import { X509Certificate } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { normalizeBackupConnection } from "../../packages/db/scripts/webhook-backup-connection.mjs"

// Public Supabase project root CA provided from Database Settings → SSL
// Configuration; pin the DER fingerprint so only this reviewed trust anchor
// can authorize the verified-full backup connection.
const BACKUP_ROOT_CA_PATH = fileURLToPath(
  new URL("../certs/supabase-root-2021-ca.crt", import.meta.url)
)
const BACKUP_ROOT_CA_CONTAINER_PATH = "/tmp/supabase-root-2021-ca.crt"
const BACKUP_ROOT_CA_SHA256 = "807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa"

function verifiedBackupRootCaContainerPath() {
  let certificate
  try {
    certificate = new X509Certificate(readFileSync(BACKUP_ROOT_CA_PATH))
  } catch {
    throw new Error("Backup TLS trust anchor is unavailable or invalid")
  }
  if (
    !certificate.ca ||
    certificate.subject !== certificate.issuer ||
    !certificate.verify(certificate.publicKey) ||
    certificate.fingerprint256.replaceAll(":", "").toLowerCase() !== BACKUP_ROOT_CA_SHA256
  ) {
    throw new Error("Backup TLS trust anchor does not match the reviewed Supabase root")
  }
  return BACKUP_ROOT_CA_CONTAINER_PATH
}

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
  // Pin the user-supplied Supabase root by DER fingerprint and mount only this
  // certificate read-only into the backup container. No URL-supplied CA or CA
  // learned from the database connection can change this trust anchor.
  libpq.searchParams.set("sslrootcert", verifiedBackupRootCaContainerPath())
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
