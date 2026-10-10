import { expect, test } from "@playwright/test"

test("personal preferences are clearly unavailable and workspace channels remain discoverable", async ({
  page,
}) => {
  await page.goto("?notification-preferences")

  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible()
  await expect(
    page.getByText("Your stored choices are retained for a future release.", { exact: false })
  ).toBeVisible()
  await expect(page.getByText("Scan updates appear in the dashboard.")).toBeVisible()
  await expect(page.getByRole("link", { name: "Workspace settings" })).toHaveAttribute(
    "href",
    "/dashboard/settings/workspace#notification-channels"
  )

  const switches = page.getByRole("switch")
  await expect(switches).toHaveCount(3)
  for (const control of await switches.all()) {
    await expect(control).toBeDisabled()
    await expect(control).toHaveAttribute("aria-checked", "false")
  }
})

test("workspace settings link is keyboard reachable after disabled preferences", async ({
  page,
}) => {
  await page.goto("?notification-preferences")
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible()
  await page.keyboard.press("Tab")
  await expect(page.getByRole("link", { name: "Workspace settings" })).toBeFocused()
})

for (const theme of ["light", "dark"]) {
  for (const width of [390, 1280]) {
    test(`notification preferences fit a ${width}px viewport in ${theme} mode`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`?notification-preferences&theme=${theme}`)
      await expect(
        page.getByRole("heading", { name: "Personal notification preferences" })
      ).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width
      )
    })
  }
}
