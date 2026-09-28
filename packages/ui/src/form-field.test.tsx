import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { FormField, Input } from "./form-field"

describe("FormField accessibility", () => {
  it("links hint and error text to its control and preserves existing descriptions", () => {
    const markup = renderToStaticMarkup(
      <FormField label="Email" htmlFor="email" hint="Use your work email" error="Email is invalid">
        <Input id="email" aria-describedby="email-format email-hint" />
        <p id="email-format">Email format requirements</p>
      </FormField>
    )

    expect(markup).toContain('aria-describedby="email-format email-hint email-error"')
    expect(markup).toContain('aria-invalid="true"')
    expect(markup).toContain('<p id="email-hint"')
    expect(markup).toContain("Use your work email")
    expect(markup).toContain('<p id="email-error"')
    expect(markup).toContain("Email is invalid")
    expect(markup).toContain('<p id="email-format">Email format requirements</p>')
  })

  it("preserves manually managed control attributes when no hint or error is provided", () => {
    const markup = renderToStaticMarkup(
      <FormField label="Password" htmlFor="password">
        <Input id="password" aria-describedby="password-hint" aria-invalid="true" />
      </FormField>
    )

    expect(markup).toContain('aria-describedby="password-hint"')
    expect(markup).toContain('aria-invalid="true"')
  })
})
