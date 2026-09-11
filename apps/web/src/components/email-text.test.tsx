import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { EmailText } from "./email-text"

describe("EmailText", () => {
  it("splits the address at the @ so CDN email obfuscation cannot match it", () => {
    const html = renderToStaticMarkup(
      createElement(EmailText, { value: "user@example.com" })
    )
    // The wire HTML must not contain a literal local@domain run that
    // Cloudflare's obfuscator rewrites into a __cf_email__ anchor.
    expect(html).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
    expect(html).toContain("<wbr/>")
    // The decoded text content still reads as the full address.
    expect(html.replace(/<[^>]+>/g, "")).toBe("user@example.com")
  })

  it("renders non-email values unchanged", () => {
    const html = renderToStaticMarkup(createElement(EmailText, { value: "Ankit" }))
    expect(html).toContain("Ankit")
    expect(html).not.toContain("<wbr/>")
  })

  it("passes through span props", () => {
    const html = renderToStaticMarkup(
      createElement(EmailText, { value: "a@b.co", className: "truncate" })
    )
    expect(html).toContain('class="truncate"')
  })
})
