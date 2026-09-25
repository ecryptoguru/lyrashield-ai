import { describe, expect, it } from "vitest"
import {
  checkHeaders,
  checkRlsSql,
  checkSetCookie,
  inspectJwt,
  scanTextForSecrets,
} from "./tool-checks"

function jwtPart(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

describe("browser-local security tool checks", () => {
  it("detects and redacts current secret formats", () => {
    const secret = ["sb", "secret", "x".repeat(24)].join("_")
    const findings = scanTextForSecrets(`SUPABASE_SERVICE_ROLE=${secret}`)

    expect(findings).toContainEqual({ kind: "Supabase secret", preview: "sb_s...xxxx" })
    expect(JSON.stringify(findings)).not.toContain(secret)
  })

  it("catches prefixed and quoted credential assignments", () => {
    // The identifier prefix (`DB_`, `POSTGRES_`, `MYSQL_`) and a quoted JSON key
    // both used to defeat this pattern: `\b` cannot sit between `_` and
    // `password`, because `_` is itself a word character, and the optional quote
    // was placed after the separator rather than before it. `.json` is an
    // accepted file type on this tool, so JSON config was effectively unscannable.
    const cases = [
      ["DB_PASSWORD=hunter2hunter2hunter2", "hunter2hunter2hunter2"],
      ["POSTGRES_PASSWORD=correcthorsebatteryst", "correcthorsebatteryst"],
      ["MYSQL_PASSWORD=abcdefghijklmnopqrst", "abcdefghijklmnopqrst"],
      ['{"db_password": "correcthorsebatterystaple"}', "correcthorsebatterystaple"],
      ['{"apiKey": "verysecretvalue123456"}', "verysecretvalue123456"],
    ]

    for (const [text, secret] of cases) {
      const findings = scanTextForSecrets(text)
      expect(findings.length, `expected a finding for: ${text}`).toBeGreaterThan(0)
      // The matched value must never be echoed back in full.
      expect(JSON.stringify(findings), `leaked the value from: ${text}`).not.toContain(secret)
    }
  })

  it("does not flag ordinary code or short values", () => {
    // Guard against over-correcting the pattern above: these must stay clean.
    const clean = [
      "function transform(x){return x}",
      "const userMessage = req.body.text;",
      "if (password.length < 8) throw new Error('too short')",
      "apiKey: short",
      "The password field is validated.",
    ]
    for (const text of clean) {
      expect(scanTextForSecrets(text), `false positive on: ${text}`).toEqual([])
    }
  })

  it("does not let comments satisfy the RLS checks", () => {
    expect(checkRlsSql("-- enable row level security\nselect 1;")).toContain(
      "No ENABLE ROW LEVEL SECURITY statement found outside comments or strings."
    )
    expect(
      checkRlsSql(`
        alter table public.projects enable row level security;
        alter table public.projects force row level security;
        create policy owner_access on public.projects using (auth.uid() = user_id);
      `)
    ).toEqual(["No simple risky pattern found. Confirm behavior with a real two-account test."])
  })

  it("parses header names and flags credentialed wildcard CORS", () => {
    const findings = checkHeaders(`
      content-security-policy: default-src 'self'; frame-ancestors 'none'
      strict-transport-security: max-age=31536000
      x-content-type-options: nosniff
      referrer-policy: no-referrer
      permissions-policy: camera=()
      access-control-allow-origin: *
      access-control-allow-credentials: true
    `)

    expect(findings).toEqual([
      "CORS combines a wildcard origin with credentials; replace it with an explicit allowlist.",
    ])
  })

  it("decodes padded Base64URL safely and reports JWT time risks", () => {
    const token = `${jwtPart({ alg: "none" })}.${jwtPart({ exp: 1, iss: "test" })}.signature`
    const findings = inspectJwt(token, 2_000)

    expect(findings).toContain("Unsafe: alg=none must never be accepted.")
    expect(findings).toContain("This token is expired.")
  })

  it("reports missing session-cookie attributes", () => {
    expect(checkSetCookie("Set-Cookie: session=abc; Path=/")).toEqual([
      "A session cookie is missing Secure.",
      "A session cookie is missing HttpOnly.",
      "A session cookie is missing an explicit SameSite policy.",
    ])
    expect(checkSetCookie("session=abc; Secure; HttpOnly; SameSite=Lax")).toEqual([])
  })
})
