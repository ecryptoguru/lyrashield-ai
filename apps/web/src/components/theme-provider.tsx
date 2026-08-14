"use client"

import { useEffect } from "react"

const THEME_EVENT = "lyrashield-theme-change"

export type ThemePreference = "system" | "light" | "dark"

function getThemeCookie(): ThemePreference | null {
  const value = document.cookie.match(/(?:^|; )lyrashield-theme=(system|light|dark)(?:;|$)/)?.[1]
  return value === "system" || value === "light" || value === "dark" ? value : null
}

function setThemeCookie(preference: ThemePreference) {
  const domain =
    window.location.hostname === "lyrashieldai.com" ||
    window.location.hostname.endsWith(".lyrashieldai.com")
      ? "; Domain=.lyrashieldai.com"
      : ""
  document.cookie = `lyrashield-theme=${preference}; Max-Age=31536000; Path=/${domain}; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`
}

export function applyTheme(preference: ThemePreference) {
  const dark =
    preference === "dark" ||
    (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  document.documentElement.classList.toggle("dark", dark)
  document.documentElement.dataset.theme = preference
  document.documentElement.style.colorScheme = dark ? "dark" : "light"
}

export function setThemePreference(preference: ThemePreference) {
  window.localStorage.setItem("lyrashield-theme", preference)
  setThemeCookie(preference)
  applyTheme(preference)
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: preference }))
}

export function getThemePreference(): ThemePreference {
  const cookie = getThemeCookie()
  if (cookie) return cookie
  const stored = window.localStorage.getItem("lyrashield-theme")
  return stored === "light" || stored === "dark" ? stored : "system"
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const syncSystemTheme = () => {
      if (getThemePreference() === "system") applyTheme("system")
    }
    media.addEventListener("change", syncSystemTheme)
    return () => media.removeEventListener("change", syncSystemTheme)
  }, [])

  return children
}

export { THEME_EVENT }
