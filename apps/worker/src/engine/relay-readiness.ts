import { registerScanWorker } from "@lyrashield/integrations"
import { resolveRelayRuntimeConfig } from "./relay-client"

/** Configuration and transport capability only; not an end-to-end scan receipt. */
export async function isTargetRelayReady(
  runtimeEnv: NodeJS.ProcessEnv = process.env,
  probe: typeof fetch = fetch
): Promise<boolean> {
  const config = resolveRelayRuntimeConfig(runtimeEnv)
  if (!config) return false
  try {
    const response = await probe(`${config.url}/health/relay`, {
      redirect: "error",
      signal: AbortSignal.timeout(3_000),
    })
    if (!response.ok) return false
    const body: unknown = await response.json()
    return typeof body === "object" && body !== null && "relay" in body && body.relay === true
  } catch {
    return false
  }
}

export async function registerRelayAwareWorker(workerId: string): Promise<void> {
  const relayReady = await isTargetRelayReady()
  // Atomic publication preserves ordinary readiness when an optional probe is negative.
  // A Redis write failure propagates to the existing heartbeat fail-closed lifecycle.
  await registerScanWorker(workerId, Date.now(), relayReady)
}
