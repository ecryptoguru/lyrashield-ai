import { expect, test, type Page } from "@playwright/test"

function supportCase(id: string) {
  return {
    id,
    reference: `MYRA-${id}`,
    status: "OPEN",
    subject: `Case ${id}`,
    summary: `Summary ${id}`,
    accountId: null,
    publicSessionId: `session-${id}`,
    workspaceId: null,
    replyEmail: `${id}@example.com`,
    emailVerifiedAt: null,
    conversationId: null,
    assigneeUserId: null,
    takenOverAt: "2026-09-19T10:00:00.000Z",
    lastUserReplyAt: null,
    lastOperatorReplyAt: null,
    resolvedAt: null,
    notificationState: "sent",
    handoffSummary: null,
    handoffReviewedAt: null,
    handoffReviewedBy: null,
    createdAt: "2026-09-19T10:00:00.000Z",
    updatedAt: "2026-09-19T10:00:00.000Z",
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

const cases = [supportCase("A"), supportCase("B")]
const caseButton = (page: Page, id: string) =>
  page.getByRole("region", { name: "Case list" }).getByRole("button", { name: `Case ${id}` })
const detail = (page: Page) => page.getByRole("region", { name: "Case detail" })

async function fixtures(page: Page) {
  const requests: { path: string; method: string; body: unknown }[] = []
  page.on("request", (request) => {
    if (request.url().includes("/api/")) {
      requests.push({
        path: new URL(request.url()).pathname + new URL(request.url()).search,
        method: request.method(),
        body: request.postDataJSON(),
      })
    }
  })
  await page.route("**/api/admin/elevations", (route) =>
    route.fulfill({ json: { data: { nonce: "test-action-nonce" } } })
  )
  await page.route("**/api/myra/operator/cases**", async (route) => {
    const url = new URL(route.request().url())
    const id = url.pathname.split("/")[5]
    if (route.request().method() !== "GET") {
      await route.fulfill({ json: { data: {} } })
    } else if (id) {
      await route.fulfill({ json: { data: { case: supportCase(id), replies: [] } } })
    } else {
      await route.fulfill({
        json: {
          data: { cases: url.searchParams.has("status") ? [cases[1]] : cases, nextCursor: null },
        },
      })
    }
  })
  return requests
}

async function openCase(page: Page, id: string) {
  await caseButton(page, id).click()
  await expect(detail(page).getByRole("heading", { name: `Case ${id}`, exact: true })).toBeVisible()
}

async function draft(page: Page, id: string) {
  await page.getByLabel("Reply to requester").fill(`Draft ${id}`)
  await page.getByLabel("Reviewed handoff summary").fill(`Reviewed summary ${id}`)
  await page
    .getByLabel("Authenticator code", { exact: true })
    .fill(id === "A" ? "111111" : "222222")
}

async function expectDraftB(page: Page) {
  await expect(detail(page).getByRole("heading", { name: "Case B", exact: true })).toBeVisible()
  await expect(page.getByLabel("Reply to requester")).toHaveValue("Draft B")
  await expect(page.getByLabel("Reviewed handoff summary")).toHaveValue("Reviewed summary B")
  await expect(page.getByLabel("Authenticator code", { exact: true })).toHaveValue("222222")
}

test("reselecting the active filter and case is a no-op, including drafts", async ({ page }) => {
  const requests = await fixtures(page)
  await page.goto("")
  await openCase(page, "A")
  await draft(page, "A")
  await page.getByRole("button", { name: "All", exact: true }).click()
  await expect(caseButton(page, "A")).toBeVisible()
  await caseButton(page, "A").click()
  await expect(detail(page).getByRole("heading", { name: "Case A", exact: true })).toBeVisible()
  await expect(page.getByLabel("Reply to requester")).toHaveValue("Draft A")
  expect(requests.filter((request) => request.method === "GET")).toHaveLength(2)
})

for (const action of ["reply", "patch"] as const) {
  for (const success of [true, false]) {
    test(`delayed ${action} ${success ? "success" : "error"} cannot replace B or its drafts/filter`, async ({
      page,
    }) => {
      const requests = await fixtures(page)
      const started = deferred()
      const release = deferred()
      const finished = deferred()
      await page.route("**/api/myra/operator/cases/A**", async (route) => {
        if (route.request().method() === "GET") return route.fallback()
        started.resolve()
        await release.promise
        await route.fulfill({
          status: success ? 200 : 500,
          json: success ? { data: {} } : { error: { message: "A mutation failed" } },
        })
        finished.resolve()
      })
      await page.goto("")
      await openCase(page, "A")
      await draft(page, "A")
      await page
        .getByRole("button", { name: action === "reply" ? "Send reply" : "Resolve", exact: true })
        .click()
      await started.promise
      await openCase(page, "B")
      await draft(page, "B")
      await page.getByRole("button", { name: "Open", exact: true }).click()
      await expect(caseButton(page, "A")).toHaveCount(0)
      release.resolve()
      await finished.promise
      // Wait for the old operation's finally callback before testing its effects.
      await expect(page.getByRole("button", { name: "Send reply", exact: true })).toBeEnabled()
      await expectDraftB(page)
      await expect(caseButton(page, "A")).toHaveCount(0)
      await expect(page.getByRole("alert")).toHaveCount(0)
      expect(
        requests.filter(
          (request) => request.path === "/api/myra/operator/cases/A" && request.method === "GET"
        )
      ).toHaveLength(1)
      // Consequential action must target the detail currently shown.
      await page.getByRole("button", { name: "Send reply", exact: true }).click()
      await expect
        .poll(() => requests.find((request) => request.path.endsWith("/B/replies")))
        .toMatchObject({
          method: "POST",
          body: { body: "Draft B" },
        })
    })
  }
}

test("an action waiting for elevation is abandoned when the selection changes", async ({
  page,
}) => {
  const requests = await fixtures(page)
  const started = deferred()
  const release = deferred()
  await page.route("**/api/admin/elevations", async (route) => {
    started.resolve()
    await release.promise
    await route.fulfill({ json: { data: { nonce: "old-elevation" } } })
  })
  await page.goto("")
  await openCase(page, "A")
  await draft(page, "A")
  await page.getByRole("button", { name: "Resolve", exact: true }).click()
  await started.promise
  await openCase(page, "B")
  await draft(page, "B")
  release.resolve()
  await expect(page.getByRole("button", { name: "Resolve", exact: true })).toBeEnabled()
  await expectDraftB(page)
  expect(requests.filter((request) => request.method === "PATCH")).toEqual([])
})

test("a failed current action retains its draft and can retry with a fresh elevation", async ({
  page,
}) => {
  const requests = await fixtures(page)
  let attempt = 0
  await page.route("**/api/myra/operator/cases/A/replies", (route) => {
    attempt += 1
    return route.fulfill({
      status: attempt === 1 ? 500 : 200,
      json: attempt === 1 ? { error: { message: "Try again" } } : { data: {} },
    })
  })
  await page.goto("")
  await openCase(page, "A")
  await draft(page, "A")
  await page.getByRole("button", { name: "Send reply", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Try again")
  await expect(page.getByLabel("Reply to requester")).toHaveValue("Draft A")
  await page.getByRole("button", { name: "Send reply", exact: true }).click()
  await expect(page.getByLabel("Reply to requester")).toHaveValue("")
  expect(requests.filter((request) => request.path === "/api/admin/elevations")).toHaveLength(2)
})

test("unmount during mutation completion starts no follow-up reads", async ({ page }) => {
  const requests = await fixtures(page)
  const started = deferred()
  const release = deferred()
  const finished = deferred()
  await page.route("**/api/myra/operator/cases/A/replies", async (route) => {
    started.resolve()
    await release.promise
    await route.fulfill({ json: { data: {} } })
    finished.resolve()
  })
  await page.goto("")
  await openCase(page, "A")
  await draft(page, "A")
  await page.getByRole("button", { name: "Send reply", exact: true }).click()
  await started.promise
  await page.evaluate(() => window.dispatchEvent(new Event("test:unmount")))
  release.resolve()
  await finished.promise
  await page.waitForTimeout(100)
  expect(requests.filter((request) => request.method === "GET")).toHaveLength(2)
})

test("reselecting the active case preserves the loaded detail and draft", async ({ page }) => {
  const requests = await fixtures(page)
  await page.goto("")
  await openCase(page, "A")
  await draft(page, "A")
  await caseButton(page, "A").click()
  await expect(detail(page).getByRole("heading", { name: "Case A", exact: true })).toBeVisible()
  await expect(page.getByLabel("Reply to requester")).toHaveValue("Draft A")
  expect(requests.filter((request) => request.method === "GET")).toHaveLength(2)
})

test("failed list and detail reads expose an explicit retry without reselecting", async ({
  page,
}) => {
  await fixtures(page)
  let listAttempt = 0
  let detailAttempt = 0
  await page.route("**/api/myra/operator/cases", (route) => {
    listAttempt += 1
    return listAttempt === 1
      ? route.fulfill({ status: 500, json: { error: { message: "List unavailable" } } })
      : route.fallback()
  })
  await page.route("**/api/myra/operator/cases/A", (route) => {
    detailAttempt += 1
    return detailAttempt === 1
      ? route.fulfill({ status: 500, json: { error: { message: "Detail unavailable" } } })
      : route.fallback()
  })
  await page.goto("")
  await expect(page.getByText("List unavailable")).toBeVisible()
  await page.getByRole("button", { name: "Retry loading cases" }).click()
  await caseButton(page, "A").click()
  await expect(page.getByText("Detail unavailable")).toBeVisible()
  await page.getByRole("button", { name: "Retry loading case", exact: true }).click()
  await expect(detail(page).getByRole("heading", { name: "Case A", exact: true })).toBeVisible()
})

test("delayed detail and list reads cannot restore an old selection or filter", async ({
  page,
}) => {
  await fixtures(page)
  const detailStarted = deferred()
  const listStarted = deferred()
  const release = deferred()
  await page.route("**/api/myra/operator/cases/A", async (route) => {
    detailStarted.resolve()
    await release.promise
    await route.fallback()
  })
  await page.route("**/api/myra/operator/cases?status=NEW", async (route) => {
    listStarted.resolve()
    await release.promise
    await route.fulfill({ json: { data: { cases: [cases[0]], nextCursor: null } } })
  })
  await page.goto("")
  await caseButton(page, "A").click()
  await detailStarted.promise
  await openCase(page, "B")
  await draft(page, "B")
  await page.getByRole("button", { name: "New", exact: true }).click()
  await listStarted.promise
  await page.getByRole("button", { name: "Open", exact: true }).click()
  await expect(caseButton(page, "B")).toBeVisible()
  release.resolve()
  await expectDraftB(page)
  await expect(caseButton(page, "A")).toHaveCount(0)
})

test("returning to A while its old reply is pending preserves the new A draft", async ({
  page,
}) => {
  await fixtures(page)
  const started = deferred()
  const release = deferred()
  await page.route("**/api/myra/operator/cases/A/replies", async (route) => {
    started.resolve()
    await release.promise
    await route.fulfill({ json: { data: {} } })
  })
  await page.goto("")
  await openCase(page, "A")
  await draft(page, "A")
  await page.getByRole("button", { name: "Send reply", exact: true }).click()
  await started.promise
  await openCase(page, "B")
  await openCase(page, "A")
  await page.getByLabel("Reply to requester").fill("New A draft")
  await page.getByLabel("Authenticator code", { exact: true }).fill("333333")
  release.resolve()
  await expect(page.getByRole("button", { name: "Send reply", exact: true })).toBeEnabled()
  await expect(page.getByLabel("Reply to requester")).toHaveValue("New A draft")
  await expect(page.getByLabel("Authenticator code", { exact: true })).toHaveValue("333333")
})

for (const width of [390, 768, 1440]) {
  test(`support controls stay keyboard accessible without overflow at ${width}px`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    await page.setViewportSize({ width, height: 900 })
    await fixtures(page)
    await page.goto("")
    await caseButton(page, "B").focus()
    await page.keyboard.press("Enter")
    await expect(detail(page).getByRole("heading", { name: "Case B", exact: true })).toBeVisible()
    await page.getByLabel("Reply to requester").focus()
    await page.keyboard.type("Keyboard draft")
    await expect(page.getByLabel("Reply to requester")).toHaveValue("Keyboard draft")
    const layout = await page.evaluate(() => {
      const list = document.querySelector('[aria-label="Case list"]')!
      const detail = document.querySelector('[aria-label="Case detail"]')!
      return {
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        display: getComputedStyle(list.parentElement!).display,
        sideBySide: detail.getBoundingClientRect().left > list.getBoundingClientRect().right,
      }
    })
    expect(layout).toEqual({ overflow: false, display: "grid", sideBySide: width === 1440 })
    expect(errors).toEqual([])
  })
}
