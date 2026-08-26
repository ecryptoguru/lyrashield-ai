#!/usr/bin/env node

import { pathToFileURL } from "node:url"

const versionedRef = /^envkeystore\/lyrashield-evidence-kek\/v([1-9][0-9]*)$/

function decodeKek(name, value) {
  if (!value) throw new Error(`${name} is not set`)
  const decoded = Buffer.from(value, "base64")
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error(`${name} must be canonical base64 encoding exactly 32 bytes`)
  }
}

export function validateKekConfig(environment = process.env) {
  const activeRef = environment.LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF ?? ""
  const activeMatch = versionedRef.exec(activeRef)
  if (!activeMatch) {
    throw new Error(
      "LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF must be envkeystore/lyrashield-evidence-kek/v<positive integer>"
    )
  }
  decodeKek("LYRASHIELD_EVIDENCE_KEK", environment.LYRASHIELD_EVIDENCE_KEK)

  let keyring
  try {
    keyring = JSON.parse(environment.LYRASHIELD_EVIDENCE_KEK_KEYRING ?? "")
  } catch {
    throw new Error("LYRASHIELD_EVIDENCE_KEK_KEYRING must be a JSON object")
  }
  if (!keyring || typeof keyring !== "object" || Array.isArray(keyring)) {
    throw new Error("LYRASHIELD_EVIDENCE_KEK_KEYRING must be a JSON object")
  }

  const activeVersion = Number(activeMatch[1])
  const activeKek = environment.LYRASHIELD_EVIDENCE_KEK
  for (const [ref, secret] of Object.entries(keyring)) {
    const match = versionedRef.exec(ref)
    if (!match || Number(match[1]) === activeVersion) {
      throw new Error("LYRASHIELD_EVIDENCE_KEK_KEYRING must contain only non-active versioned refs")
    }
    decodeKek("LYRASHIELD_EVIDENCE_KEK_KEYRING value", secret)
    if (secret === activeKek) {
      throw new Error("LYRASHIELD_EVIDENCE_KEK must differ from every retained historical key")
    }
  }
  for (let version = 1; version < activeVersion; version += 1) {
    if (!keyring[`envkeystore/lyrashield-evidence-kek/v${version}`]) {
      throw new Error("LYRASHIELD_EVIDENCE_KEK_KEYRING must retain every prior version")
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    validateKekConfig()
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
