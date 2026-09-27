export {}

declare global {
  interface Window {
    posthog?: import("posthog-js").PostHog
  }
}
