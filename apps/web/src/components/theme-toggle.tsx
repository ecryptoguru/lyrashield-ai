"use client"

import { useSyncExternalStore } from "react"
import { Monitor, Moon, Sun } from "lucide-react"
import { Button } from "@lyrashield/ui"
import {
  getThemePreference,
  setThemePreference,
  THEME_EVENT,
  type ThemePreference,
} from "./theme-provider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

const themes: Array<{ value: ThemePreference; label: string; icon: typeof Monitor }> = [
  { value: "system", label: "System theme", icon: Monitor },
  { value: "light", label: "Light theme", icon: Sun },
  { value: "dark", label: "Dark theme", icon: Moon },
]

export function ThemeToggle({ className }: { className?: string }) {
  const preference = useSyncExternalStore(
    (onChange) => {
      window.addEventListener(THEME_EVENT, onChange)
      window.addEventListener("storage", onChange)
      return () => {
        window.removeEventListener(THEME_EVENT, onChange)
        window.removeEventListener("storage", onChange)
      }
    },
    getThemePreference,
    () => "system"
  )

  const currentIndex = themes.findIndex((theme) => theme.value === preference)
  const current = themes[currentIndex] ?? themes[0]!
  const Icon = current.icon

  function cycleTheme() {
    const next = themes[(currentIndex + 1) % themes.length]!
    setThemePreference(next.value)
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={className}
          onClick={cycleTheme}
          aria-label={`${current.label}. Change color theme`}
        >
          <Icon aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{current.label}</TooltipContent>
    </Tooltip>
  )
}
