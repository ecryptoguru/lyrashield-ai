"use client"

import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { createWebMcpReceiptStore, type WebMcpReceiptStore } from "@/lib/webmcp/receipts"
import { WebMcpActivityDrawer } from "./webmcp-activity-drawer"

const WebMcpReceiptContext = createContext<WebMcpReceiptStore | null>(null)

export function WebMcpReceiptProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => createWebMcpReceiptStore())

  useEffect(() => {
    // Clearing on full reload is the default because the store lives in React
    // state, but also flush explicitly on beforeunload so a hard reload does
    // not leave the previous tab's in-memory receipt list visible briefly.
    const onBeforeUnload = () => {
      store.clear()
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload)
    }
  }, [store])

  return (
    <WebMcpReceiptContext.Provider value={store}>
      {children}
      <WebMcpActivityDrawer />
    </WebMcpReceiptContext.Provider>
  )
}

export function useWebMcpReceiptStore(): WebMcpReceiptStore {
  const store = useContext(WebMcpReceiptContext)
  if (!store) {
    throw new Error("useWebMcpReceiptStore must be used within WebMcpReceiptProvider")
  }
  return store
}
