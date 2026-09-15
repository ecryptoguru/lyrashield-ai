/**
 * Unit tests for the output/input sanitizers. These guard spec §3/§4 rules:
 * model output is rendered as an allowlisted markdown subset, links resolve
 * only to https on LyraShield hosts or manifest-relative paths, and obvious
 * secrets are screened before text reaches the model or persistence.
 */
import { describe, expect, it } from "vitest"
import { escapeHtml, sanitizeLinkHref, sanitizeMarkdown, screenSecrets } from "./sanitize"

describe("sanitizeLinkHref", () => {
  it("accepts https links on allowlisted LyraShield hosts", () => {
    for (const href of [
      "https://lyrashieldai.com/pricing",
      "https://www.lyrashieldai.com/tools",
      "https://app.lyrashieldai.com/dashboard/scans",
      "https://lyrashieldai.com/docs/integrations?x=1#y",
    ]) {
      const out = sanitizeLinkHref(href)
      expect(out, href).not.toBeNull()
      expect(out).toMatch(/^https:\/\/(www\.|app\.)?lyrashieldai\.com\//)
    }
  })

  it("normalizes scheme/host case on allowlisted hosts", () => {
    const out = sanitizeLinkHref("HTTPS://LYRASHIELDAI.COM/Pricing")
    expect(out).not.toBeNull()
    expect(out).toMatch(/^https:\/\/lyrashieldai\.com\//)
  })

  it("accepts manifest-relative paths", () => {
    expect(sanitizeLinkHref("/dashboard")).toBe("/dashboard")
    expect(sanitizeLinkHref("/pricing?ref=myra#compare")).toBe("/pricing?ref=myra#compare")
    expect(sanitizeLinkHref("  /support  ")).toBe("/support")
  })

  it("rejects dangerous schemes", () => {
    for (const href of [
      "javascript:alert(1)",
      "javascript:alert(1)//",
      "  javascript:void(0)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "data:text/html,<script>alert(1)</script>",
      "ftp://lyrashieldai.com/x",
      "file:///etc/passwd",
      "vbscript:msgbox(1)",
    ]) {
      expect(sanitizeLinkHref(href), href).toBeNull()
    }
  })

  it("rejects plain http even on an allowlisted host", () => {
    expect(sanitizeLinkHref("http://lyrashieldai.com/pricing")).toBeNull()
  })

  it("rejects protocol-relative URLs (//host is not a relative path)", () => {
    expect(sanitizeLinkHref("//evil.com/x")).toBeNull()
    expect(sanitizeLinkHref("//lyrashieldai.com/pricing")).toBeNull()
  })

  it("rejects lookalike and userinfo-spoofed hosts", () => {
    for (const href of [
      "https://evil.com",
      "https://lyrashieldai.com.evil.com/",
      "https://evil-lyrashieldai.com/",
      "https://lyrashieldai.com@evil.com/",
      "https://evil.com?q=lyrashieldai.com",
      "https://sub.lyrashieldai.com/",
    ]) {
      expect(sanitizeLinkHref(href), href).toBeNull()
    }
  })

  it("rejects relative paths longer than 300 chars", () => {
    expect(sanitizeLinkHref(`/${"a".repeat(299)}`)).not.toBeNull()
    expect(sanitizeLinkHref(`/${"a".repeat(300)}`)).toBeNull()
  })

  it("rejects empty, whitespace-only and unparseable input", () => {
    for (const href of ["", "   ", "not a url", "https://", "?q=1", "#frag"]) {
      expect(sanitizeLinkHref(href), JSON.stringify(href)).toBeNull()
    }
  })
})

describe("escapeHtml", () => {
  it("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')">&`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#039;1&#039;)&quot;&gt;&amp;"
    )
  })
})

describe("sanitizeMarkdown", () => {
  const hrefs = (md: string) =>
    sanitizeMarkdown(md)
      .filter((s) => s.kind === "link")
      .map((s) => s.href)

  it("keeps code spans literal — no link/format parsing inside backticks", () => {
    const segs = sanitizeMarkdown("run `[x](javascript:alert(1)) **now**` first")
    const code = segs.find((s) => s.kind === "code")
    expect(code?.text).toBe("[x](javascript:alert(1)) **now**")
    expect(hrefs("run `[x](javascript:alert(1))`")).toEqual([])
  })

  it("renders allowlisted links as link segments", () => {
    const segs = sanitizeMarkdown("see [pricing](https://lyrashieldai.com/pricing) now")
    expect(segs.map((s) => s.kind)).toEqual(["text", "link", "text"])
    expect(segs[1]).toMatchObject({
      text: "pricing",
      href: "https://lyrashieldai.com/pricing",
    })
  })

  it("renders manifest-relative links", () => {
    expect(hrefs("[install](/docs/integrations)")).toEqual(["/docs/integrations"])
  })

  it("degrades disallowed links to plain label text", () => {
    for (const md of [
      "[click](javascript:alert)",
      "[click](data:text/html;base64,PHNjcmlwdD4=)",
      "[click](https://evil.com/phish)",
      "[click](//evil.com)",
      "[click](ftp://lyrashieldai.com/x)",
    ]) {
      const segs = sanitizeMarkdown(md)
      expect(segs.every((s) => s.kind !== "link"), md).toBe(true)
      expect(segs.map((s) => s.text).join("")).toBe("click")
    }
  })

  it("degrades image syntax to text — no image or raw-URL constructs survive", () => {
    const segs = sanitizeMarkdown("![tracker](https://evil.com/pixel.png)")
    expect(segs.every((s) => s.kind !== "link")).toBe(true)
    expect(segs.every((s) => s.kind !== "code")).toBe(true)
  })

  it("leaves bold/italic markers as literal text for the renderer", () => {
    const segs = sanitizeMarkdown("**bold** and *italic*")
    expect(segs).toEqual([{ kind: "text", text: "**bold** and *italic*" }])
  })

  it("does not parse links with over-length labels or spaced hrefs", () => {
    expect(hrefs(`[${"a".repeat(201)}](https://lyrashieldai.com)`)).toEqual([])
    expect(hrefs("[x](https://lyrashieldai.com/a b)")).toEqual([])
  })

  it("caps total output at maxLength", () => {
    const long = `start ${"x".repeat(9000)} [l](https://lyrashieldai.com) end`
    const segs = sanitizeMarkdown(long, 8000)
    const textLen = segs.reduce((n, s) => n + s.text.length, 0)
    expect(textLen).toBeLessThanOrEqual(8000)
  })

  it("produces only text/code/link segments — no passthrough of raw markup", () => {
    const segs = sanitizeMarkdown(
      "hi <script>alert(1)</script> `code` [ok](/support) <b>bold</b>"
    )
    expect(segs.every((s) => ["text", "code", "link"].includes(s.kind))).toBe(true)
    const joined = segs.map((s) => s.text).join("")
    expect(joined).toContain("<script>") // raw text, escaped by renderer — never a link
    expect(segs.filter((s) => s.kind === "link")).toHaveLength(1)
  })
})

describe("screenSecrets", () => {
  it("redacts LyraShield API keys (lsk_)", () => {
    const key = "lsk_live_ab12cd34ef56"
    const { text, redacted } = screenSecrets(`my key is ${key} ok`)
    expect(redacted).toBe(1)
    expect(text).toContain("[redacted-secret]")
    expect(text).not.toContain(key)
  })

  it("does not redact lsk_-prefixed strings that are too short", () => {
    const { redacted } = screenSecrets("lsk_short stays")
    expect(redacted).toBe(0)
  })

  it("redacts JWT-shaped tokens", () => {
    const jwt = `${"a".repeat(24)}.${"b".repeat(10)}.${"c".repeat(25)}`
    const { text, redacted } = screenSecrets(`auth: ${jwt}`)
    expect(redacted).toBe(1)
    expect(text).not.toContain(jwt)
  })

  it("redacts multi-line private key blocks", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7\nqqqqqq\n-----END RSA PRIVATE KEY-----"
    const { text, redacted } = screenSecrets(`here:\n${pem}\ndone`)
    expect(redacted).toBe(1)
    expect(text).not.toContain("MIIEowIBAAKCAQEA7")
    expect(text).toContain("[redacted-secret]")
  })

  it("redacts GitHub, AWS and Slack tokens", () => {
    const gh = `ghp_${"g".repeat(24)}`
    const aws = `AKIA${"A".repeat(16)}`
    const slack = `xoxb-${"1".repeat(12)}`
    const { redacted } = screenSecrets(`${gh} ${aws} ${slack}`)
    expect(redacted).toBe(3)
  })

  it("counts each redaction across a mixed payload", () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"
    const jwt = `${"a".repeat(24)}.${"b".repeat(10)}.${"c".repeat(25)}`
    const { redacted } = screenSecrets(`k=lsk_0123456789ab j=${jwt} p=${pem}`)
    expect(redacted).toBe(3)
  })

  it("leaves clean text untouched", () => {
    const clean = "how do I add a target in the dashboard?"
    const { text, redacted } = screenSecrets(clean)
    expect(redacted).toBe(0)
    expect(text).toBe(clean)
  })
})
