#!/usr/bin/env node
/**
 * Generate the evidence envelope key-encryption key (KEK).
 *
 * Prints a base64-encoded 32-byte random key — the exact format
 * LYRASHIELD_EVIDENCE_KEK expects. Run once, store the output durably
 * (password manager / KMS / printed sealed backup): losing the KEK makes
 * every envelope-encrypted evidence artifact written under it unreadable.
 * There is no export path from the HKDF that derives the runtime key.
 *
 * Where the value must be provisioned (see docs/deployment/PRODUCTION_DEPLOYMENT.md):
 *   - GitHub secret LYRASHIELD_EVIDENCE_KEK (deploy workflow syncs the app
 *     Container App secret from it on every deploy)
 *   - Key Vault secret worker-evidence-kek (worker VM, via
 *     ops/worker/refresh-secrets.sh)
 */
import { randomBytes } from "node:crypto"

const kek = randomBytes(32).toString("base64")

process.stdout.write(
  [
    "LyraShield evidence envelope KEK (LYRASHIELD_EVIDENCE_KEK):",
    "",
    kek,
    "",
    "Store this value durably BEFORE provisioning it: loss makes envelope-",
    "encrypted evidence unreadable. Do not commit it or paste it into chats,",
    "logs, or tickets.",
    "",
  ].join("\n")
)
