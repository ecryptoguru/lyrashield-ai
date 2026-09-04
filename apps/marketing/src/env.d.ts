/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

declare const __MARKETING_INDEXABLE__: boolean
declare const __MARKETING_X_URL__: string
declare const __MARKETING_BUILD_REVISION__: string
declare const __MARKETING_SOURCE_DATES__: Readonly<Record<string, string>>

interface Window {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  posthog?: any
}

// Work around Astro 7.1.4 Picture.astro typing: it uses props.inferSize on
// LocalImageProps | RemoteImageProps, but inferSize is only declared on RemoteImageProps.
declare global {
  namespace Astro {
    interface CustomImageProps {
      inferSize?: boolean
    }
  }
}
