/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

declare const __MARKETING_INDEXABLE__: boolean
declare const __MARKETING_X_URL__: string

interface Window {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  posthog?: any
}
