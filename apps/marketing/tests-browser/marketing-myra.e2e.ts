import { expect, test } from "@playwright/test"

async function mockMyra(
  page: import("@playwright/test").Page,
  booking = true,
  interactive = false,
  statusTimeout = false,
  iframeChallenge = false
) {
  await page.addInitScript(
    ({ bookingOpen, interactiveChallenge, statusTimeout, iframeChallenge }) => {
      const calls: { path: string; credentials?: RequestCredentials }[] = []
      Object.assign(window, { __myraCalls: calls })
      const originalFetch = window.fetch.bind(window)
      window.fetch = async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof Request ? input.url : input.href,
          location.href
        )
        if (
          url.origin !== "https://app.lyrashieldai.com" ||
          !url.pathname.startsWith("/api/myra/")
        ) {
          return originalFetch(input, init)
        }
        calls.push({ path: url.pathname, credentials: init?.credentials })
        if (url.pathname === "/api/myra/status" && statusTimeout)
          return new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("status timeout", "AbortError")),
              { once: true }
            )
          )
        if (url.pathname === "/api/myra/status")
          return Response.json({ public: true, booking: bookingOpen })
        if (url.pathname === "/api/myra/session") {
          return Response.json({ data: { publicToken: "test-public", sessionId: "test-session" } })
        }
        if (url.pathname === "/api/myra/demo/slots") {
          return Response.json({
            data: {
              slots: [
                {
                  id: "slot-1",
                  startsAt: "2030-01-07T16:00:00+05:30",
                  endsAt: "2030-01-07T16:30:00+05:30",
                },
              ],
            },
          })
        }
        if (url.pathname.startsWith("/api/myra/demo/manage/")) {
          return Response.json({
            data: {
              booking: { startsAt: "2030-01-07T16:00:00+05:30", status: "CONFIRMED" },
              copy: "Booking found.",
            },
          })
        }
        if (url.pathname === "/api/myra/message") {
          return new Response('data: {"type":"done"}\n\n', {
            headers: { "content-type": "text/event-stream" },
          })
        }
        return Response.json({ data: {}, suggestions: [] })
      }
      Object.assign(window, {
        turnstile: {
          render: (_host: Element, options: { callback?: (token: string) => void }) => {
            Object.assign(window, { __challengeWasInert: Boolean(_host.closest("[inert]")) })
            if (iframeChallenge) {
              const frame = document.createElement("iframe")
              frame.srcdoc = '<button type="button">Complete iframe challenge</button>'
              frame.style.width = "180px"
              frame.style.height = "64px"
              _host.appendChild(frame)
              return "widget-1"
            }
            const challenge = document.createElement("button")
            challenge.type = "button"
            challenge.textContent = "Complete challenge"
            challenge.style.width = "160px"
            challenge.style.height = "48px"
            _host.appendChild(challenge)
            if (interactiveChallenge)
              challenge.addEventListener("click", () => options.callback?.("challenge-ok"))
            else queueMicrotask(() => options.callback?.("challenge-ok"))
            return "widget-1"
          },
          execute: () => {},
          remove: () => {},
        },
      })
    },
    { bookingOpen: booking, interactiveChallenge: interactive, statusTimeout, iframeChallenge }
  )
}

test("mobile Myra contains focus and restores page interaction after close and resize", async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await mockMyra(page)
  await page.goto("/")
  await expect(page.locator("html")).toHaveJSProperty("scrollWidth", 390)
  const launcher = page.getByRole("button", { name: "Ask Myra" })
  await launcher.click()
  const dialog = page.getByRole("dialog", { name: "Myra support" })
  await expect(dialog).toHaveAttribute("aria-modal", "true")
  await expect(page.locator("main")).toHaveAttribute("inert", "")
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden")
  await expect(page.locator("[data-myra-turnstile]")).not.toHaveAttribute("inert", "")
  await page.keyboard.press("Shift+Tab")
  await expect(dialog.locator(":focus")).toHaveCount(1)
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await expect(launcher).toBeFocused()
  await expect(page.locator("main")).not.toHaveAttribute("inert", "")

  await launcher.click()
  await page.setViewportSize({ width: 768, height: 1024 })
  await expect(dialog).toHaveAttribute("aria-modal", "false")
  await expect(page.locator("main")).not.toHaveAttribute("inert", "")
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden")
  await expect(page.locator("html")).toHaveJSProperty("scrollWidth", 768)
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(page.locator("html")).toHaveJSProperty("scrollWidth", 1440)
  expect(pageErrors).toEqual([])
})

test("mobile Myra challenge stays outside the inert demo page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockMyra(page, false, true)
  await page.goto("/demo")
  await expect(page.getByRole("heading", { name: "Request a demo time" })).toBeVisible()
  expect(
    await page.evaluate(() =>
      (window as unknown as { __myraCalls: { path: string }[] }).__myraCalls.some(
        ({ path }) => path === "/api/myra/demo/slots"
      )
    )
  ).toBe(false)
  await page.getByRole("button", { name: "Ask Myra" }).click()
  expect(
    await page.evaluate(() => {
      const panel = document.getElementById("myra-panel")
      const host = document.querySelector("[data-myra-turnstile]:not(main *)")
      return panel?.parentElement === document.body && host?.parentElement === document.body
    })
  ).toBe(true)
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __challengeWasInert?: boolean }).__challengeWasInert
      )
    )
    .toBe(false)
  const challenge = page.getByRole("button", { name: "Complete challenge" })
  await challenge.focus()
  await page.keyboard.press("Shift+Tab")
  await expect(page.getByRole("dialog", { name: "Myra support" }).locator(":focus")).toHaveCount(1)
  await challenge.focus()
  await page.keyboard.press("Tab")
  await expect(page.getByRole("dialog", { name: "Myra support" }).locator(":focus")).toHaveCount(1)
  await challenge.click()
})

test("resizing an open desktop panel to mobile moves focus into the modal", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 })
  await mockMyra(page)
  await page.goto("/")
  await page.getByRole("button", { name: "Ask Myra" }).click()
  const dialog = page.getByRole("dialog", { name: "Myra support" })
  await expect(dialog).toHaveAttribute("aria-modal", "false")
  await page.locator("main a[href]").first().focus()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(dialog).toHaveAttribute("aria-modal", "true")
  await expect(dialog.locator(":focus")).toHaveCount(1)
})

test("Turnstile challenge stays above Myra composer on desktop and mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await mockMyra(page, true, true)
  await page.goto("/")
  await page.getByRole("button", { name: "Ask Myra" }).click()

  const challenge = page.locator("[data-myra-turnstile] button")
  const form = page.locator("#myra-form")
  await expect(challenge).toBeVisible()
  const assertChallengeAboveComposer = async () => {
    const [challengeBox, formBox] = await Promise.all([challenge.boundingBox(), form.boundingBox()])
    expect(challengeBox).not.toBeNull()
    expect(formBox).not.toBeNull()
    expect(challengeBox!.y + challengeBox!.height).toBeLessThanOrEqual(formBox!.y)
  }
  await assertChallengeAboveComposer()

  await page.setViewportSize({ width: 390, height: 844 })
  await assertChallengeAboveComposer()
})

test("reverse Tab from a Turnstile iframe stays inside the mobile dialog", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockMyra(page, false, true, false, true)
  await page.goto("/demo")
  await page.getByRole("button", { name: "Ask Myra" }).click()
  const challenge = page
    .frameLocator("body > [data-myra-turnstile] iframe")
    .getByRole("button", { name: "Complete iframe challenge" })
  await challenge.focus()
  await page.keyboard.press("Shift+Tab")
  const dialog = page.getByRole("dialog", { name: "Myra support" })
  await expect(dialog.locator(":focus")).toHaveCount(1)
  await page.keyboard.press("Tab")
  await expect(page.locator("body > [data-myra-turnstile] iframe")).toBeFocused()
  await challenge.focus()
  await page.keyboard.press("Tab")
  await expect(dialog.locator(":focus")).toHaveCount(1)
})

test("status timeout keeps demo fallback availability-neutral", async ({ page }) => {
  await mockMyra(page, true, false, true)
  await page.goto("/demo")
  await expect(page.getByRole("heading", { name: "Request a demo time" })).toBeVisible()
  await page.waitForTimeout(2200)
  await expect(page.getByRole("heading", { name: "Request a demo time" })).toBeVisible()
  await expect(page.getByText("Demo booking opens soon")).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Request a time" })).toBeVisible()
})

test("demo booking and management use public requests without cookies", async ({ page }) => {
  await mockMyra(page)
  await page.goto("/demo#manage=manage-token")
  await expect(page.getByText("Booking found.")).toBeVisible()
  const calls = await page.evaluate(
    () =>
      (window as unknown as { __myraCalls: { path: string; credentials?: string }[] }).__myraCalls
  )
  expect(calls.filter(({ path }) => path !== "/api/myra/status")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "/api/myra/demo/manage/manage-token", credentials: "omit" }),
    ])
  )
})

test("open demo slots use the anonymous token without cookies", async ({ page }) => {
  await mockMyra(page)
  await page.goto("/demo")
  await expect(page.getByText(/open times/)).toBeVisible()
  await expect(
    page.locator("article > p").filter({ hasText: "Demo booking opens soon" })
  ).toHaveCount(0)
  const calls = await page.evaluate(
    () =>
      (window as unknown as { __myraCalls: { path: string; credentials?: string }[] }).__myraCalls
  )
  expect(calls).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "/api/myra/demo/slots", credentials: "omit" }),
    ])
  )
})

test("public support case verification omits browser cookies", async ({ page }) => {
  await mockMyra(page)
  await page.goto("/")
  await page.getByRole("button", { name: "Ask Myra" }).click()
  // The button's accessible name is its visible label, which is "Talk to a
  // person" at sm+ and "Support" below it. The mobile project renders the
  // short form, so match either rather than re-adding an aria-label that would
  // break WCAG 2.5.3 (label in name).
  await page.getByRole("button", { name: /^(Talk to a person|Support)$/ }).click()
  await page.getByRole("textbox", { name: "Case subject" }).fill("Need help with a scan")
  await page
    .getByRole("textbox", { name: "Case details" })
    .fill("The scan shows an unexpected result.")
  await page.getByRole("textbox", { name: "Email for replies" }).fill("person@example.com")
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page.getByRole("textbox", { name: "Verification code" })).toBeVisible()
  await page.getByRole("textbox", { name: "Verification code" }).fill("123456")
  await page.getByRole("button", { name: "Verify" }).click()
  const calls = await page.evaluate(
    () =>
      (window as unknown as { __myraCalls: { path: string; credentials?: string }[] }).__myraCalls
  )
  expect(calls).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "/api/myra/identity/request", credentials: "omit" }),
      expect.objectContaining({ path: "/api/myra/identity/confirm", credentials: "omit" }),
    ])
  )
})
