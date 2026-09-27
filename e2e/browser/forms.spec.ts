import { expect, test } from "@playwright/test"

test("shared controls and Myra composer stay at least 16px on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("?forms")

  for (const name of ["Shared input", "Shared textarea", "Shared select"]) {
    const control = page.getByLabel(name)
    const fontSize = await control.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).fontSize)
    )
    expect(fontSize, `${name} font size`).toBeGreaterThanOrEqual(16)
  }

  await page.getByRole("button", { name: "Ask Myra" }).click()
  const composer = page.getByRole("textbox", { name: "Message Myra" })
  const fontSize = await composer.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize)
  )
  expect(fontSize, "Myra composer font size").toBeGreaterThanOrEqual(16)
})
