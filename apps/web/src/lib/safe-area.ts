// Safe-area utilities for iOS notch / dynamic island devices.
// These values are environment variables read by the browser; fallbacks are 0.

export function safeAreaStyle(): { paddingTop: string; paddingBottom: string } {
  return {
    paddingTop: "env(safe-area-inset-top)",
    paddingBottom: "env(safe-area-inset-bottom)",
  }
}

export const SAFE_AREA_CLASSES = {
  top: "pt-[env(safe-area-inset-top)]",
  bottom: "pb-[env(safe-area-inset-bottom)]",
  left: "pl-[env(safe-area-inset-left)]",
  right: "pr-[env(safe-area-inset-right)]",
} as const
