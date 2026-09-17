/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

declare const __MARKETING_INDEXABLE__: boolean
declare const __MARKETING_LOCAL_PREVIEW__: boolean
declare const __MARKETING_X_URL__: string
declare const __MARKETING_BUILD_REVISION__: string
declare const __MARKETING_SOURCE_DATES__: Readonly<Record<string, string>>

interface Window {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  posthog?: any
}

interface ImportMetaEnv {
  /** "1" mounts the Myra support launcher on marketing pages. Default off. */
  readonly PUBLIC_MYRA_MARKETING_ENABLED?: string
  /** Turnstile site key — reused for Myra anonymous-session abuse checks. */
  readonly PUBLIC_TURNSTILE_SITE_KEY?: string
  /** App origin the Myra panel calls for its API. */
  readonly PUBLIC_APP_URL?: string
  /** Search Console HTML-tag verification code; omit to skip the tag. */
  readonly PUBLIC_GOOGLE_SITE_VERIFICATION?: string
  /** Bing Webmaster Tools verification code; omit to skip the tag. */
  readonly PUBLIC_BING_SITE_VERIFICATION?: string
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
