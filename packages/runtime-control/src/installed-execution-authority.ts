import { execFileSync } from "node:child_process"
import { lstatSync } from "node:fs"
import { createConnection } from "node:net"
import { z } from "zod"
import { authorityActionSchema, type AuthorityAction } from "./authority-fence"
import type { AuthoritySqlConnection } from "./postgres-mirror"
import { canonicalJson } from "./canonical-json"
import { preparationDelegationSchema } from "./preparation-delegation"

const identity = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .refine((value) => !value.includes(".."))
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const installedExecutionAuthoritySchema = z
  .object({
    purpose: z.literal("production-installed"),
    epochId: identity,
    epoch: z.number().int().positive().max(2147483647),
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    runtimePolicyDigest: digest,
    authorityDigest: digest,
    supervisorInstanceId: identity,
    preparation: preparationDelegationSchema.optional(),
  })
  .strict()
export type InstalledExecutionAuthority = Readonly<
  z.infer<typeof installedExecutionAuthoritySchema>
>
export interface InstalledExecutionAuthorityCapability {
  /** Caller retains the native gate and checks its approved descriptor against this exact identity. */
  verifyAction(
    client: AuthoritySqlConnection,
    action: AuthorityAction
  ): Promise<InstalledExecutionAuthority>
}
const helper = "/opt/lyrashield/runtime-control/paired-runtime-host-observation.py"
const pin = "/opt/lyrashield/runtime-control/runtime-qualification-key.json"
const observerSocket = "/opt/lyrashield-runtime/authority.sock"
function fail(): never {
  throw new Error("Installed execution authority unavailable")
}
function requireAuthority(value: unknown): asserts value {
  if (!value) fail()
}
/** Fixed supervisor observer requests; no caller selects a socket, key or helper. */
export async function readSupervisorAuthoritySocket(
  request: "execution-authority\n" | "disposable-execution-authority\n"
): Promise<unknown> {
  requireAuthority(process.getuid?.() !== 0)
  const gid = process.getgid?.()
  requireAuthority(gid !== undefined)
  for (const path of ["/opt", "/opt/lyrashield-runtime"]) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed root-owned socket ancestry
    const entry = lstatSync(path)
    requireAuthority(
      entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        entry.uid === 0 &&
        (entry.mode & 0o022) === 0
    )
  }
  const socket = lstatSync(observerSocket)
  requireAuthority(
    socket.isSocket() &&
      !socket.isSymbolicLink() &&
      socket.uid === 0 &&
      socket.gid === gid &&
      (socket.mode & 0o777) === 0o660
  )
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const client = createConnection({ path: observerSocket })
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const timer = setTimeout(() => finish(new Error("Authority observation timed out")), 6000)
    function finish(error?: Error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        client.destroy()
        reject(error)
      } else resolve(Buffer.concat(chunks))
    }
    client.once("connect", () => client.end(request))
    client.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > 8192) finish(new Error("Authority response too large"))
      else chunks.push(chunk)
    })
    client.once("end", () => finish())
    client.once("close", () => finish(new Error("Authority connection closed")))
    client.once("error", finish)
  })
  requireAuthority(bytes.length > 1 && bytes.indexOf(10) === bytes.length - 1)
  return JSON.parse(bytes.subarray(0, -1).toString("utf8"))
}

async function readInstalled(): Promise<InstalledExecutionAuthority> {
  if (process.getuid?.() !== 0) {
    return Object.freeze(
      installedExecutionAuthoritySchema.parse(
        await readSupervisorAuthoritySocket("execution-authority\n")
      )
    )
  }
  for (const path of ["/opt", "/opt/lyrashield", "/opt/lyrashield/runtime-control", helper, pin]) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed root installation paths; no request selects a key or verifier
    const entry = lstatSync(path)
    requireAuthority(entry.uid === 0 && !entry.isSymbolicLink() && (entry.mode & 0o022) === 0)
  }
  const bytes = execFileSync("/usr/bin/python3", [helper, "execution-authority", pin], {
    timeout: 6000,
    maxBuffer: 8192,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      NODE_ENV: "production",
      PATH: "/usr/bin:/bin",
      PYTHONNOUSERSITE: "1",
      PYTHONDONTWRITEBYTECODE: "1",
    },
  })
  return Object.freeze(installedExecutionAuthoritySchema.parse(JSON.parse(bytes.toString("utf8"))))
}

/** Authenticated read-only host identity; action authority still requires the native database fence. */
export async function observeInstalledExecutionAuthority(): Promise<InstalledExecutionAuthority> {
  requireAuthority(arguments.length === 0)
  try {
    return await readInstalled()
  } catch {
    return fail()
  }
}
/** Fixed installed producer only. It never accepts a verifier, trusted boolean, path, purpose or key. */
export function createInstalledExecutionAuthorityCapability(): InstalledExecutionAuthorityCapability {
  requireAuthority(arguments.length === 0)
  return Object.freeze({
    async verifyAction(client: AuthoritySqlConnection, input: AuthorityAction) {
      try {
        const action = authorityActionSchema.parse(input)
        const installed = await readInstalled()
        requireAuthority(installed.epochId === action.authorityEpochId)
        const epoch = await client.query(
          `SELECT id,epoch::text,app.scan_preparation_gate_held() AS held
         FROM "ScanAuthorityEpoch" WHERE id=$1 AND epoch=$2::integer
         AND "isOpen"=true AND "openKey"='open'
         AND epoch=(SELECT max(epoch) FROM "ScanAuthorityEpoch") FOR SHARE`,
          [installed.epochId, String(installed.epoch)]
        )
        requireAuthority(epoch.rows.length === 1 && epoch.rows[0]?.held === true)
        requireAuthority(
          epoch.rows[0]?.id === installed.epochId &&
            epoch.rows[0]?.epoch === String(installed.epoch)
        )
        // The checked connection belongs to the action fence. A failed/lost query
        // rejects before returning identity; the caller retains its gate through invocation.
        requireAuthority(canonicalJson(await readInstalled()) === canonicalJson(installed))
        const held = await client.query("SELECT app.scan_preparation_gate_held() AS held", [])
        requireAuthority(held.rows.length === 1 && held.rows[0]?.held === true)
        return installed
      } catch {
        return fail()
      }
    },
  })
}
