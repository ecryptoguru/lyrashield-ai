/**
 * Launch Readiness Report signing-key resolution (WP4).
 *
 * Mirrors the license-signing key pattern (packages/billing/src/
 * license-fulfillment.ts): the private key comes from the env in dev and from
 * Azure Key Vault in production (managed identity via DefaultAzureCredential).
 * Single published key (founder-ruled 2026-09-02); a per-report keypair +
 * transparency log is a later upgrade that does not change the document format.
 *
 * Fail-closed: with no key configured, resolution returns null and reports
 * issue unsigned — never a guessed or hardcoded key.
 */

import { createPrivateKey, createPublicKey } from "node:crypto"
import { env } from "@lyrashield/config"

let cachedPrivateKey: string | null = null
let cachedPublicKey: string | null = null

function isProduction(): boolean {
  return env.NODE_ENV === "production"
}

/**
 * Resolve the launch-report signing private key (PKCS#8 PEM), or null when not
 * configured. Production reads it from Azure Key Vault (LYRASHIELD_KEY_VAULT_NAME
 * + LAUNCH_REPORT_SIGNING_PRIVATE_KEY_SECRET_NAME); dev reads the env var.
 */
export async function resolveLaunchReportSigningPrivateKey(): Promise<string | null> {
  if (isProduction() && env.LYRASHIELD_KEY_VAULT_NAME) {
    if (cachedPrivateKey) return cachedPrivateKey
    const { DefaultAzureCredential } = await import("@azure/identity")
    const { SecretClient } = await import("@azure/keyvault-secrets")
    const client = new SecretClient(
      `https://${env.LYRASHIELD_KEY_VAULT_NAME}.vault.azure.net`,
      new DefaultAzureCredential()
    )
    const secretName = env.LAUNCH_REPORT_SIGNING_PRIVATE_KEY_SECRET_NAME
    const secret = await client.getSecret(secretName)
    const value = secret.value
    if (!value || !value.includes("-----BEGIN")) {
      throw new Error(
        `Key Vault secret "${secretName}" is missing or not a PEM key. ` +
          "Provision it per the launch-report signing runbook."
      )
    }
    cachedPrivateKey = value
    return value
  }

  const key = env.LAUNCH_REPORT_SIGNING_PRIVATE_KEY
  return key || null
}

/**
 * Resolve the public key (SPKI PEM) for the verify endpoint. Prefers the
 * configured public key / Key Vault; otherwise derives it from the private key.
 * Returns null when no key is configured at all.
 */
export async function resolveLaunchReportSigningPublicKey(): Promise<string | null> {
  if (env.LAUNCH_REPORT_SIGNING_PUBLIC_KEY) return env.LAUNCH_REPORT_SIGNING_PUBLIC_KEY

  if (isProduction() && env.LYRASHIELD_KEY_VAULT_NAME) {
    if (cachedPublicKey) return cachedPublicKey
    const { DefaultAzureCredential } = await import("@azure/identity")
    const { SecretClient } = await import("@azure/keyvault-secrets")
    const client = new SecretClient(
      `https://${env.LYRASHIELD_KEY_VAULT_NAME}.vault.azure.net`,
      new DefaultAzureCredential()
    )
    const secretName = env.LAUNCH_REPORT_SIGNING_PUBLIC_KEY_SECRET_NAME
    const secret = await client.getSecret(secretName)
    if (secret.value && secret.value.includes("-----BEGIN")) {
      cachedPublicKey = secret.value
      return secret.value
    }
  }

  const privateKeyPem = await resolveLaunchReportSigningPrivateKey()
  if (!privateKeyPem) return null
  const derived = createPublicKey(createPrivateKey({ key: privateKeyPem, format: "pem" }))
  return derived.export({ type: "spki", format: "pem" }).toString()
}
