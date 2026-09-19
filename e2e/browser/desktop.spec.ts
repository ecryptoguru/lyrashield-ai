import { expect, test, type Page } from "@playwright/test"
import wire from "./desktop-wire.json" with { type: "json" }

async function native(
  page: Page,
  options: {
    delay?: number
    listenerFailure?: boolean
    replayFailure?: boolean
    connected?: boolean
    running?: boolean
    startDelay?: number
    cancelDelay?: number
    replayDelay?: number
    syncSuccess?: boolean
    empty?: boolean
    cancelFailure?: boolean
    historyFailure?: boolean
    detailFailure?: boolean
    historyDelay?: number
    holdFirstListener?: boolean
  } = {}
) {
  await page.addInitScript(
    ({ options, wire }) => {
      const state = {
        calls: [] as { command: string; args?: Record<string, unknown> }[],
        listeners: new Map<string, (event: { payload: unknown }) => void>(),
        failures: 0,
        listenCalls: 0,
        resolvedListenCalls: 0,
        releaseListener: null as (() => void) | null,
      }
      Object.assign(window, { desktopState: state })
      const detail = {
        ...wire.detail,
        status: options.running ? "running" : "completed",
        findings: options.empty ? [] : wire.detail.findings,
      }
      const connection = {
        workspaceId: "workspace-a",
        seq: 0,
        cursor: null,
        lastSyncedFindingId: null,
        connectedAt: "2026-09-19",
        lastSyncAt: null,
      }
      window.desktopNative = {
        async invoke(command, args) {
          state.calls.push({ command, args, resolvedListeners: state.resolvedListenCalls })
          if (command === "startup_revalidate_license")
            return {
              state: "expired_eligibility",
              updateEligibleUntil: "2026-01-01",
              perpetualFallbackBuild: "1.0",
              offlineGraceRemainingSeconds: null,
            }
          if (command === "list_scans") {
            if (options.historyDelay)
              await new Promise((resolve) => setTimeout(resolve, options.historyDelay))
            if (options.historyFailure && state.failures++ === 0) throw Error("History unavailable")
            return options.empty ? [] : [detail]
          }
          if (command === "get_scan_detail" && options.detailFailure && state.failures++ === 0)
            throw Error("Detail unavailable")
          if (command === "get_scan_detail")
            return args?.scanId === "scan-b"
              ? { ...detail, scan_id: "scan-b", status: "running", findings: [] }
              : detail
          if (command === "start_scan") {
            if (options.startDelay)
              await new Promise((resolve) => setTimeout(resolve, options.startDelay))
            return "scan-a"
          }
          if (command === "cancel_scan") {
            if (options.cancelFailure) throw Error("Terminal persistence failed")
            if (options.cancelDelay)
              await new Promise((resolve) => setTimeout(resolve, options.cancelDelay))
            detail.status = "cancelled"
            state.listeners.get("scan://cancelled")?.({
              payload: { type: "cancelled", scan_id: "scan-a" },
            })
            return null
          }
          if (command === "export_sarif") return JSON.stringify({ version: "2.1.0" })
          if (command === "get_scan_events") {
            if (options.replayDelay)
              await new Promise((resolve) => setTimeout(resolve, options.replayDelay))
            if (options.replayFailure && state.failures++ === 0) throw Error("Replay unavailable")
            if (args?.scanId === "scan-b") return []
            return options.running ? [] : [{ seq: 0, event: wire.events[3] }]
          }
          if (command === "get_sync_state") return options.connected ? connection : null
          if (command === "has_sync_api_key") return true
          if (command === "connect_workspace") return connection
          if (command === "sync_findings")
            return [options.syncSuccess ? wire.syncResults[0] : wire.syncResults[2]]
          return null
        },
        async listen(event, handler) {
          state.listenCalls++
          if (options.holdFirstListener && state.listenCalls === 1)
            await new Promise<void>((resolve) => {
              state.releaseListener = resolve
            })
          if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay))
          if (options.listenerFailure && event === "scan://finding" && state.failures++ === 0)
            throw Error("Listener unavailable")
          state.listeners.set(event, handler)
          state.resolvedListenCalls++
          return () => {
            state.listeners.delete(event)
          }
        },
      }
    },
    { options, wire }
  )
}

test("listener registration finishes before replay; stored detail restores fast completed findings", async ({
  page,
}) => {
  await native(page, { delay: 70 })
  await page.goto("?desktop=progress")
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { desktopState: { listenCalls: number } }).desktopState.listenCalls
      )
    )
    .toBeGreaterThan(0)
  const replayCall = await page.evaluate(() =>
    (
      window as unknown as {
        desktopState: { calls: { command: string; resolvedListeners: number }[] }
      }
    ).desktopState.calls.find((c) => c.command === "get_scan_events")
  )
  expect(replayCall?.resolvedListeners).toBeGreaterThanOrEqual(1)
  await expect(page.getByText("completed", { exact: true })).toBeVisible()
  await expect(page.getByText("Alpha", { exact: true })).toBeVisible()
})

test("history reopens persisted findings and sync sends only explicit selections, preserving selection on entitlement retry", async ({
  page,
}) => {
  await native(page, { connected: true })
  await page.goto("?desktop=app")
  await page.getByRole("button", { name: /Open scan/ }).click()
  await expect(page.getByText("Alpha", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: /Back/ }).click()
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  await expect(page.getByRole("button", { name: "Sync 0 Findings" })).toBeDisabled()
  await page.getByLabel("Alpha").check()
  await page.getByRole("button", { name: "Sync 1 Findings" }).click()
  await expect(page.getByText(/Sync addon required/)).toBeVisible()
  await expect(page.getByLabel("Alpha")).toBeChecked()
  await expect(page.getByLabel("Beta")).not.toBeChecked()
  await page.getByRole("button", { name: "Sync 1 Findings" }).click()
  await expect(page.getByText(/Sync addon required/)).toBeVisible()
  const calls = await page.evaluate(() =>
    (
      window as unknown as {
        desktopState: { calls: { command: string; args?: Record<string, unknown> }[] }
      }
    ).desktopState.calls.filter((c) => c.command === "sync_findings")
  )
  expect(calls).toHaveLength(2)
  expect(calls[1]?.args?.findings).toEqual(calls[0]?.args?.findings)
  expect(calls[0]?.args?.findings).toEqual([
    expect.objectContaining({
      id: "f0",
      file_path: "src/example.ts",
      line_number: 7,
      detected_at: "2026-09-19",
    }),
  ])
})

for (const failure of ["listenerFailure", "replayFailure"] as const) {
  test(`${failure} is visible, cleans listeners, and retry recovers`, async ({ page }) => {
    await native(page, { [failure]: true })
    await page.goto("?desktop=progress")
    await expect(page.getByRole("alert")).toContainText("unavailable")
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { desktopState: { listeners: Map<string, unknown> } }).desktopState
            .listeners.size
      )
    ).toBe(0)
    await page.getByRole("button", { name: "Retry scan updates" }).click()
    await expect(page.getByText("Alpha", { exact: true })).toBeVisible()
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { desktopState: { listeners: Map<string, unknown> } }).desktopState
            .listeners.size
      )
    ).toBe(7)
    await page.evaluate(() => window.dispatchEvent(new Event("test:unmount")))
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { desktopState: { listeners: Map<string, unknown> } }).desktopState
            .listeners.size
      )
    ).toBe(0)
  })
}

test("unmount during delayed registration cleans late listeners without replay", async ({
  page,
}) => {
  await native(page, { holdFirstListener: true })
  await page.goto("?desktop=progress")
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { desktopState: { listenCalls: number } }).desktopState.listenCalls
      )
    )
    .toBeGreaterThan(0)
  await page.evaluate(() => window.dispatchEvent(new Event("test:unmount")))
  await page.evaluate(() =>
    (
      window as unknown as { desktopState: { releaseListener: () => void } }
    ).desktopState.releaseListener()
  )
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { desktopState: { resolvedListenCalls: number } }).desktopState
            .resolvedListenCalls
      )
    )
    .toBe(7)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { desktopState: { listeners: Map<string, unknown> } }).desktopState
            .listeners.size
      )
    )
    .toBe(0)
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { desktopState: { calls: { command: string }[] } }
      ).desktopState.calls.some((c) => c.command === "get_scan_events")
    )
  ).toBe(false)
})

test("cancel remains Cancelling until durable confirmation; live native fields are decoded", async ({
  page,
}) => {
  await native(page, { running: true, cancelDelay: 400 })
  await page.goto("?desktop=progress")
  await expect(page.getByText("running", { exact: true })).toBeVisible()
  await page.evaluate(() =>
    (
      window as unknown as {
        desktopState: { listeners: Map<string, (event: { payload: unknown }) => void> }
      }
    ).desktopState.listeners.get("scan://progress")?.({
      payload: { type: "progress", scan_id: "scan-a", line: "Native live line", stream: "stdout" },
    })
  )
  await expect(page.getByText("Native live line", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(page.getByText("Cancelling…", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled()
  await expect(page.getByText("cancelled", { exact: true })).toBeVisible()
})

test("new scan Back prevents late start navigation; history restores after reload", async ({
  page,
}) => {
  await native(page, { startDelay: 400 })
  await page.goto("?desktop=app")
  await page.getByRole("button", { name: "New Scan", exact: true }).click()
  await page.getByLabel("Local path", { exact: true }).fill("/local/project")
  await page.getByRole("button", { name: "Start Scan", exact: true }).click()
  await page.getByRole("button", { name: /Back/ }).click()
  await page.waitForTimeout(500)
  await expect(page.getByRole("heading", { name: "Scan history" })).toBeVisible()
  await page.reload()
  await page.getByRole("button", { name: /Open scan/ }).click()
  await expect(page.getByText("Alpha", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Export SARIF" }).click()
  const call = await page.evaluate(() =>
    (
      window as unknown as {
        desktopState: { calls: { command: string; args?: Record<string, unknown> }[] }
      }
    ).desktopState.calls.find((c) => c.command === "export_sarif")
  )
  expect(call?.args?.findings).toEqual(wire.detail.findings)
})

for (const connected of [false, true]) {
  test(`sync Back is keyboard accessible and preserves connection (${connected})`, async ({
    page,
  }) => {
    await native(page, { connected })
    await page.goto("?desktop=app")
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Cloud Sync" })).toBeVisible()
    await page.getByRole("button", { name: /Back/ }).focus()
    await page.keyboard.press("Enter")
    await expect(page.getByRole("heading", { name: "Scan history" })).toBeVisible()
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { desktopState: { calls: { command: string }[] } }
        ).desktopState.calls.some((c) => c.command === "disconnect_sync")
      )
    ).toBe(false)
  })
}

for (const width of [390, 768, 1440]) {
  test(`desktop history, progress and selected sync fit ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setViewportSize({ width, height: 900 })
    await native(page, { connected: true, syncSuccess: true })
    await page.goto("?desktop=app")
    await page.getByRole("button", { name: /Open scan/ }).click()
    await expect(page.getByText("Alpha", { exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole("button", { name: /Back/ }).click()
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    await page.getByLabel("Alpha", { exact: true }).check()
    await page.getByRole("button", { name: "Sync 1 Findings" }).click()
    await expect(page.getByText("Synced 1 findings", { exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({
      path: testInfo.outputPath(`desktop-sync-${width}.png`),
      fullPage: true,
    })
    expect(errors).toEqual([])
  })
}

test("scan identity change resets findings and status; old live events are ignored", async ({
  page,
}) => {
  await native(page)
  await page.goto("?desktop=progress")
  await expect(page.getByText("Alpha", { exact: true })).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event("test:scan-change")))
  await expect(page.getByRole("heading", { name: "Scan scan-b", exact: true })).toBeVisible()
  await expect(page.getByText("running", { exact: true })).toBeVisible()
  await page.evaluate(() =>
    (
      window as unknown as {
        desktopState: { listeners: Map<string, (event: { payload: unknown }) => void> }
      }
    ).desktopState.listeners.get("scan://completed")?.({
      payload: { type: "completed", scan_id: "scan-a", finding_count: 2, exit_code: 0 },
    })
  )
  await expect(page.getByText("Alpha", { exact: true })).toHaveCount(0)
  await expect(page.getByText("running", { exact: true })).toBeVisible()
})

test("persistence failure is visible and never fabricates a cancelled terminal", async ({
  page,
}) => {
  await native(page, { running: true, cancelFailure: true })
  await page.goto("?desktop=progress")
  await expect(page.getByText("running", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Terminal persistence failed")
  await expect(page.getByText("cancelled", { exact: true })).toHaveCount(0)
  await expect(page.getByText("running", { exact: true })).toBeVisible()
})

test("history error retries and empty sync stays a zero-selection no-op", async ({ page }) => {
  await native(page, { historyFailure: true, empty: true, connected: true })
  await page.goto("?desktop=app")
  await expect(page.getByRole("alert")).toContainText("History unavailable")
  await page.getByRole("button", { name: "Retry history" }).click()
  await expect(page.getByText("No local scans yet.")).toBeVisible()
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  await expect(page.getByText("No local findings available.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Sync 0 Findings" })).toBeDisabled()
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { desktopState: { calls: { command: string }[] } }
      ).desktopState.calls.some((c) => c.command === "sync_findings")
    )
  ).toBe(false)
})

test("sync detail retry cannot leave loading stuck when history refresh resolves later", async ({
  page,
}) => {
  await native(page, { connected: true, detailFailure: true, historyDelay: 200 })
  await page.goto("?desktop=app")
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Detail unavailable")
  await page.getByRole("button", { name: "Retry loading" }).click()
  await page.getByLabel("Alpha", { exact: true }).check()
  await expect(page.getByRole("button", { name: "Sync 1 Findings" })).toBeEnabled()
  await expect(page.getByRole("status")).toHaveCount(0)
})

test("active history can reopen after Back without cancelling execution", async ({ page }) => {
  await native(page, { running: true })
  await page.goto("?desktop=app")
  await page.getByRole("button", { name: /Open scan/ }).click()
  await expect(page.getByText("running", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: /Back/ }).click()
  await page.getByRole("button", { name: /Open scan/ }).click()
  await expect(page.getByText("running", { exact: true })).toBeVisible()
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { desktopState: { calls: { command: string }[] } }
      ).desktopState.calls.some((c) => c.command === "cancel_scan")
    )
  ).toBe(false)
})
