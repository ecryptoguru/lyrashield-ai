import { sanitizeBrowserErrorEvent } from "./browser-error-sanitizer"
import { analyticsPermissionAllowsOptionalCollection } from "./analytics"

type SentryModule = typeof import("@sentry/nextjs")
type SentryClient = NonNullable<ReturnType<SentryModule["init"]>>

type BrowserErrorMonitorOptions = {
  dsn?: string
  environment?: string
  release?: string
  canCollect?: () => boolean
  loadSentry?: () => Promise<SentryModule>
}

export function createBrowserErrorMonitor({
  dsn = process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment = process.env.NODE_ENV,
  release = process.env.NEXT_PUBLIC_SENTRY_RELEASE,
  canCollect = analyticsPermissionAllowsOptionalCollection,
  loadSentry = () => import("@sentry/nextjs"),
}: BrowserErrorMonitorOptions = {}) {
  let optionalCollectionAllowed = false
  let sentry: SentryModule | null = null
  let sentryClient: SentryClient | undefined
  let loading: Promise<SentryModule> | null = null

  const disable = () => {
    optionalCollectionAllowed = false
    if (sentryClient) sentryClient.getOptions().enabled = false
    sentry?.getCurrentScope().setClient(undefined)
  }

  const enable = async (): Promise<void> => {
    optionalCollectionAllowed = true
    if (!dsn || !canCollect()) {
      disable()
      return
    }

    try {
      sentry ??= await (loading ??= loadSentry().catch((error: unknown) => {
        loading = null
        throw error
      }))
    } catch {
      return
    }

    if (!optionalCollectionAllowed) return
    try {
      sentryClient ??= sentry.init({
        dsn,
        environment,
        ...(release ? { release } : {}),
        enabled: true,
        defaultIntegrations: false,
        integrations: [sentry.globalHandlersIntegration()],
        sendDefaultPii: false,
        sendClientReports: false,
        maxBreadcrumbs: 0,
        beforeBreadcrumb: () => null,
        beforeSend: (event) =>
          sanitizeBrowserErrorEvent(
            event,
            optionalCollectionAllowed &&
              canCollect() &&
              analyticsPermissionAllowsOptionalCollection()
          ),
        tracesSampleRate: 0,
        profilesSampleRate: 0,
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 0,
      })
    } catch {
      return
    }

    if (sentryClient) {
      sentryClient.getOptions().enabled = true
      sentry.getCurrentScope().setClient(sentryClient)
    }
  }

  return {
    setCollectionAllowed(allowed: boolean | null): Promise<void> {
      if (allowed !== true) {
        disable()
        return Promise.resolve()
      }
      return enable()
    },
  }
}
