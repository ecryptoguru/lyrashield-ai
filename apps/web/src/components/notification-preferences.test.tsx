import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { NotificationPreferences } from "./notification-preferences"

describe("personal notification preferences", () => {
  it("shows unavailable personal controls and explains the workspace notification settings", () => {
    const html = renderToStaticMarkup(<NotificationPreferences />)
    expect(html).toContain("Personal notification preferences")
    expect(html.match(/role="switch"/g)).toHaveLength(3)
    expect(html.match(/disabled=""/g)).toHaveLength(3)
    expect(html.match(/aria-checked="false"/g)).toHaveLength(3)
    expect(html).toContain(
      "Personal email and in-app preferences are not available yet. Your stored choices are retained for a future release."
    )
    expect(html).toContain("Scan updates appear in the dashboard")
    expect(html).toContain('href="/dashboard/settings/workspace#notification-channels"')
    expect(html).not.toMatch(/daily digest|instant alerts|saved automatically/i)
  })
})
