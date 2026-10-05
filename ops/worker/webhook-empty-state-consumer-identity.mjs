import { createHash } from "node:crypto"
import { constants, openSync, fstatSync, readFileSync, closeSync } from "node:fs"
import { checkParents } from "../../packages/db/scripts/webhook-empty-state-root-store.mjs"
import { requireValue } from "../../packages/db/scripts/webhook-empty-state-receipt-v2.mjs"
// Self-contained so the exact image can run this probe without starting any
// application/queue consumer or loading a caller-provided module.
export function runtimeFingerprint(env) {
  const hash = (value) => createHash("sha256").update(value).digest("hex")
  const database = (raw) => {
    if (typeof raw !== "string" || raw.length > 8192) throw Error("Missing connection")
    const u = new URL(raw),
      keys = [...u.searchParams.keys()]
    if (
      !["postgres:", "postgresql:"].includes(u.protocol) ||
      u.hash ||
      u.pathname !== "/postgres" ||
      (u.searchParams.get("schema") || "public") !== "public" ||
      new Set(keys).size !== keys.length ||
      keys.some((key) => !["schema", "sslmode"].includes(key)) ||
      (u.searchParams.has("sslmode") &&
        !["require", "verify-full"].includes(u.searchParams.get("sslmode")))
    )
      throw Error("Unsupported connection")
    const user = decodeURIComponent(u.username)
    let ref
    const direct = u.hostname.match(/^db\.([a-z0-9]{20})\.supabase\.co$/i)
    if (direct && user === "postgres" && ["", "5432"].includes(u.port)) ref = direct[1]
    else if (/\.pooler\.supabase\.com$/i.test(u.hostname) && ["", "5432", "6543"].includes(u.port))
      ref = user.match(/^postgres\.([a-z0-9]{20})$/i)?.[1]
    if (!ref) throw Error("Unbound connection")
    return {
      identitySha256: hash(
        JSON.stringify({
          provider: "supabase",
          projectRef: ref.toLowerCase(),
          database: "postgres",
          schema: "public",
        })
      ),
      credentialSha256: hash(raw),
    }
  }
  const url = new URL(env.REDIS_URL)
  if (
    url.protocol !== "rediss:" ||
    url.search ||
    url.hash ||
    !/^\/(?:[0-9]+)?$/.test(url.pathname || "/")
  )
    throw Error("Unsupported Redis connection")
  return {
    database: database(env.DATABASE_URL),
    system: database(env.DATABASE_SYSTEM_URL),
    redis: {
      identitySha256: hash(
        JSON.stringify({
          scheme: url.protocol,
          host: url.hostname,
          port: url.port || "6379",
          database: url.pathname.slice(1) || "0",
        })
      ),
      credentialSha256: hash(env.REDIS_URL),
    },
  }
}
export function validateConsumerFingerprint(fingerprint, policy, role) {
  requireValue(
    fingerprint.database.identitySha256 === policy.databaseIdentitySha256 &&
      fingerprint.system.identitySha256 === policy.databaseIdentitySha256 &&
      fingerprint.redis.identitySha256 === policy.redisIdentitySha256,
    "New consumer connection target differs from approved database/Redis"
  )
  const ordinary = role === "worker" ? policy.credentials.worker : policy.credentials[role]
  const system =
    role === "worker" ? policy.credentials.system : policy.candidateCredentials?.[role]?.system
  requireValue(
    fingerprint.database.credentialSha256 === ordinary &&
      fingerprint.system.credentialSha256 === system &&
      fingerprint.redis.credentialSha256 === policy.credentials.redis,
    "Refreshed consumer credential continuity changed"
  )
  return true
}
export function readRefreshedWorkerFingerprint() {
  const path = "/etc/lyrashield/worker.env"
  checkParents(path)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    requireValue(
      stat.uid === 0 &&
        stat.isFile() &&
        (stat.mode & 0o777) === 0o600 &&
        stat.nlink === 1 &&
        stat.size < 262144,
      "Unsafe refreshed worker environment"
    )
    const values = {}
    for (const line of readFileSync(fd, "utf8").split("\n")) {
      const match = line.match(/^(DATABASE_URL|DATABASE_SYSTEM_URL|REDIS_URL)=(.*)$/)
      if (!match) continue
      requireValue(!Object.hasOwn(values, match[1]), "Duplicate refreshed worker target")
      values[match[1]] = match[2]
    }
    return runtimeFingerprint(values)
  } finally {
    closeSync(fd)
  }
}
