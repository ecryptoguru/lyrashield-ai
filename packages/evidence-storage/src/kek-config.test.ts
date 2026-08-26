import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const key = (byte: number) => Buffer.alloc(32, byte).toString("base64")
const verifier = fileURLToPath(new URL("../scripts/validate-kek-config.mjs", import.meta.url))

function validate(environment: Record<string, string>) {
  return spawnSync(process.execPath, [verifier], {
    env: { PATH: process.env.PATH ?? "", ...environment },
    encoding: "utf8",
  })
}

describe("validateKekConfig", () => {
  it("accepts a versioned active key and older retained keyring", () => {
    expect(
      validate({
        LYRASHIELD_EVIDENCE_KEK: key(2),
        LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF: "envkeystore/lyrashield-evidence-kek/v2",
        LYRASHIELD_EVIDENCE_KEK_KEYRING: JSON.stringify({
          "envkeystore/lyrashield-evidence-kek/v1": key(1),
        }),
      }).status
    ).toBe(0)
  })

  it("rejects an unversioned ref, malformed key, or incomplete history", () => {
    expect(
      validate({
        LYRASHIELD_EVIDENCE_KEK: key(2),
        LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF: "envkeystore/lyrashield-evidence-kek/current",
        LYRASHIELD_EVIDENCE_KEK_KEYRING: "{}",
      }).stderr
    ).toMatch(/ACTIVE_REF/)
    expect(
      validate({
        LYRASHIELD_EVIDENCE_KEK: "not-base64",
        LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF: "envkeystore/lyrashield-evidence-kek/v1",
        LYRASHIELD_EVIDENCE_KEK_KEYRING: "{}",
      }).stderr
    ).toMatch(/canonical base64/)
    expect(
      validate({
        LYRASHIELD_EVIDENCE_KEK: key(2),
        LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF: "envkeystore/lyrashield-evidence-kek/v2",
        LYRASHIELD_EVIDENCE_KEK_KEYRING: "{}",
      }).stderr
    ).toMatch(/retain every prior version/)
    expect(
      validate({
        LYRASHIELD_EVIDENCE_KEK: key(3),
        LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF: "envkeystore/lyrashield-evidence-kek/v3",
        LYRASHIELD_EVIDENCE_KEK_KEYRING: JSON.stringify({
          "envkeystore/lyrashield-evidence-kek/v1": key(1),
        }),
      }).stderr
    ).toMatch(/retain every prior version/)
    expect(
      validate({
        LYRASHIELD_EVIDENCE_KEK: key(2),
        LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF: "envkeystore/lyrashield-evidence-kek/v2",
        LYRASHIELD_EVIDENCE_KEK_KEYRING: JSON.stringify({
          "envkeystore/lyrashield-evidence-kek/v1": key(2),
        }),
      }).stderr
    ).toMatch(/must differ/)
  })
})
