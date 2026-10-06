import { containerAppTargetArgs } from "./webhook-empty-state-azure-target.mjs"
import { spawnSync } from "node:child_process"
import {
  runtimeFingerprint,
  validateConsumerFingerprint,
} from "./webhook-empty-state-consumer-identity.mjs"
import { requireValue } from "../../packages/db/scripts/webhook-empty-state-receipt-v2.mjs"
function read(binary, args, json = false, env = {}) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 2_000_000,
    env: { PATH: "/usr/bin:/bin", HOME: "/root", ...env },
  })
  requireValue(result.status === 0, "Prepared candidate connection readback failed")
  return json ? JSON.parse(result.stdout) : result.stdout.trim()
}
export function candidateConnectionProbeSource() {
  return `import {createHash} from 'node:crypto';const fingerprint=(${runtimeFingerprint.toString()})(process.env);process.stdout.write(JSON.stringify(fingerprint));`
}
export function collectPreparedCandidateFingerprint(policy, role, ownedActive = false) {
  requireValue(["app", "scanner"].includes(role), "Unsupported candidate resource")
  const revision = policy.candidateRevisions[role]
  const observed = read(
    "/usr/bin/az",
    [
      "containerapp",
      "revision",
      "show",
      ...containerAppTargetArgs(policy.resources[role]),
      "--revision",
      revision,
      "-o",
      "json",
    ],
    true
  )
  const containers = observed.properties?.template?.containers
  requireValue(
    ((observed.properties.active === false && observed.properties.replicas === 0) ||
      (ownedActive &&
        observed.properties.active === true &&
        Number.isSafeInteger(observed.properties.replicas) &&
        observed.properties.replicas >= 0)) &&
      containers?.length === 1 &&
      containers[0].image === policy.images[role] &&
      /^ghcr\.io\/ecryptoguru\/lyrashield-ai\/lyrashield-web@sha256:[a-f0-9]{64}$/.test(
        policy.images[role]
      ),
    "Prepared candidate must be inert on the exact image before identity verification"
  )
  const resource = read(
    "/usr/bin/az",
    ["containerapp", "show", ...containerAppTargetArgs(policy.resources[role]), "-o", "json"],
    true
  )
  const environment = {},
    entries = containers[0].env
  requireValue(Array.isArray(entries), "Candidate runtime environment missing")
  for (const key of ["DATABASE_URL", "DATABASE_SYSTEM_URL", "REDIS_URL"]) {
    const matches = entries.filter((entry) => entry.name === key)
    requireValue(matches.length === 1, "Missing or duplicate candidate connection")
    const entry = matches[0]
    if (typeof entry.value === "string") environment[key] = entry.value
    else {
      const refs = resource.properties?.configuration?.secrets?.filter(
        (secret) => secret.name === entry.secretRef
      )
      requireValue(
        refs?.length === 1 &&
          refs[0].keyVaultUrl === policy.candidateSecretRefs?.[role]?.[key] &&
          /^https:\/\/[a-z0-9-]+\.vault\.azure\.net\/secrets\/[a-zA-Z0-9-]+\/[a-f0-9]{32}$/.test(
            refs[0].keyVaultUrl
          ),
        "Candidate secret must be the approved versioned reference"
      )
      environment[key] = read("/usr/bin/az", [
        "keyvault",
        "secret",
        "show",
        "--id",
        refs[0].keyVaultUrl,
        "--query",
        "value",
        "-o",
        "tsv",
      ])
    }
  }
  // Run only the immutable connection probe in the EXACT candidate image with
  // no network/consumer entrypoint. Values travel through the child environment,
  // never command arguments, logs, predicates or public artifacts.
  const fingerprint = read(
    "/usr/bin/docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--env",
      "DATABASE_URL",
      "--env",
      "DATABASE_SYSTEM_URL",
      "--env",
      "REDIS_URL",
      policy.images[role],
      "node",
      "--input-type=module",
      "-e",
      candidateConnectionProbeSource(),
    ],
    true,
    environment
  )
  validateConsumerFingerprint(fingerprint, policy, role)
  return fingerprint
}
