"use client"

import { createContext, useContext, type ReactNode } from "react"
import type { UxV2Flags } from "@/lib/flags"

const FeatureFlagsContext = createContext<UxV2Flags | null>(null)

export function FeatureFlagsProvider({
  flags,
  children,
}: {
  flags: UxV2Flags
  children: ReactNode
}) {
  return <FeatureFlagsContext.Provider value={flags}>{children}</FeatureFlagsContext.Provider>
}

export function useFeatureFlags(): UxV2Flags {
  const flags = useContext(FeatureFlagsContext)
  if (!flags) {
    throw new Error("useFeatureFlags must be used within FeatureFlagsProvider")
  }
  return flags
}
