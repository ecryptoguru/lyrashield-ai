import { afterEach, describe, expect, it, vi } from "vitest"
import type { ErrorEvent } from "@sentry/nextjs"
import { setAnalyticsPreference } from "./analytics"
import { createBrowserErrorMonitor } from "./browser-error-monitor"

type SentryModule = typeof import("@sentry/nextjs")
type SentryClient = NonNullable<ReturnType<SentryModule["init"]>>

afterEach(() => {
  setAnalyticsPreference(null)
  vi.unstubAllGlobals()
})

function fakeSentry() {
  const options = { enabled: true }
  const client = { getOptions: () => options } as unknown as SentryClient
  const scope = { setClient: vi.fn() }
  let initOptions: Parameters<SentryModule["init"]>[0] | undefined
  const init = vi.fn((nextOptions: Parameters<SentryModule["init"]>[0]) => {
    initOptions = nextOptions
    return client
  })
  const getClient = vi.fn(() => undefined)
  const integration = { name: "GlobalHandlers" }
  const globalHandlersIntegration = vi.fn(() => integration)
  const sdk = {
    init,
    getClient,
    getCurrentScope: () => scope,
    globalHandlersIntegration,
  } as unknown as SentryModule
  return {
    sdk,
    options,
    client,
    scope,
    init,
    getClient,
    integration,
    globalHandlersIntegration,
    initOptions: () => initOptions,
  }
}

describe("browser error monitor", () => {
  it("does not load the SDK before permission resolves or without a DSN", async () => {
    const loadSentry = vi.fn(async () => fakeSentry().sdk)
    const monitor = createBrowserErrorMonitor({ dsn: "", loadSentry })

    await monitor.setCollectionAllowed(null)
    await monitor.setCollectionAllowed(false)
    expect(loadSentry).not.toHaveBeenCalled()

    const enabledWithoutDsn = createBrowserErrorMonitor({ dsn: undefined, loadSentry })
    await enabledWithoutDsn.setCollectionAllowed(true)
    expect(loadSentry).not.toHaveBeenCalled()

    const preferenceDenied = createBrowserErrorMonitor({
      dsn: "https://public@example.ingest.sentry.io/1",
      canCollect: () => false,
      loadSentry,
    })
    await preferenceDenied.setCollectionAllowed(true)
    expect(loadSentry).not.toHaveBeenCalled()
  })

  it("initializes error-only capture and drops events as soon as permission is disabled", async () => {
    const sentry = fakeSentry()
    const loadSentry = vi.fn(async () => sentry.sdk)
    let browserPermission = true
    setAnalyticsPreference(true)
    const monitor = createBrowserErrorMonitor({
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "production",
      release: "lyrashield-ai+release123",
      canCollect: () => browserPermission,
      loadSentry,
    })

    await monitor.setCollectionAllowed(null)
    expect(loadSentry).not.toHaveBeenCalled()
    await monitor.setCollectionAllowed(true)

    expect(loadSentry).toHaveBeenCalledTimes(1)
    expect(sentry.init).toHaveBeenCalledTimes(1)
    expect(sentry.globalHandlersIntegration).toHaveBeenCalledTimes(1)
    const options = sentry.initOptions() as Parameters<SentryModule["init"]>[0] & {
      beforeSend: (event: ErrorEvent) => ErrorEvent | null
    }
    expect(options).toMatchObject({
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "production",
      release: "lyrashield-ai+release123",
      defaultIntegrations: false,
      sendDefaultPii: false,
      sendClientReports: false,
      maxBreadcrumbs: 0,
      tracesSampleRate: 0,
      profilesSampleRate: 0,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
    })
    expect(options.integrations).toEqual([sentry.integration])
    expect(options.beforeBreadcrumb?.({} as never)).toBeNull()
    expect(sentry.scope.setClient).toHaveBeenLastCalledWith(sentry.client)

    // Intercepted SDK event: no transport call is made by the test.
    const captured = options.beforeSend({
      message: "private prompt and target URL",
      request: { url: "https://private.test?token=secret" },
      exception: { values: [{ type: "NetworkError", value: "token=secret" }] },
    } as ErrorEvent)
    expect(captured).toMatchObject({
      transaction: "/other",
      exception: { values: [{ type: "NetworkError", value: "NetworkError" }] },
    })
    expect(JSON.stringify(captured)).not.toMatch(/private|secret|prompt|target/)

    browserPermission = false
    expect(options.beforeSend({} as ErrorEvent)).toBeNull()
    browserPermission = true
    await monitor.setCollectionAllowed(false)
    expect(sentry.options.enabled).toBe(false)
    expect(sentry.scope.setClient).toHaveBeenLastCalledWith(undefined)
    expect(options.beforeSend({} as ErrorEvent)).toBeNull()

    await monitor.setCollectionAllowed(true)
    expect(sentry.init).toHaveBeenCalledTimes(1)
    expect(sentry.options.enabled).toBe(true)
    expect(sentry.scope.setClient).toHaveBeenLastCalledWith(sentry.client)
  })

  it("rechecks DNT and GPC at send time after the SDK is enabled", async () => {
    const sentry = fakeSentry()
    setAnalyticsPreference(true)
    const monitor = createBrowserErrorMonitor({
      dsn: "https://public@example.ingest.sentry.io/1",
      loadSentry: async () => sentry.sdk,
    })
    await monitor.setCollectionAllowed(true)

    const options = sentry.initOptions() as Parameters<SentryModule["init"]>[0] & {
      beforeSend: (event: ErrorEvent) => ErrorEvent | null
    }

    // Intercepted SDK events only; the test never invokes the transport.
    vi.stubGlobal("navigator", { doNotTrack: "1", globalPrivacyControl: false })
    expect(options.beforeSend({} as ErrorEvent)).toBeNull()

    vi.stubGlobal("navigator", { doNotTrack: "0", globalPrivacyControl: true })
    expect(options.beforeSend({} as ErrorEvent)).toBeNull()
  })
})
