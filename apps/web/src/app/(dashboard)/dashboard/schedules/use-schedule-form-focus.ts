import { useLayoutEffect, useRef } from "react"

/** Restore focus only after the closed form's trigger is rendered again. */
export function useScheduleFormFocus(open: boolean, loading: boolean, targetsLoading: boolean) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)

  useLayoutEffect(() => {
    if (open) {
      wasOpen.current = true
    } else if (!loading && !targetsLoading) {
      if (wasOpen.current) triggerRef.current?.focus()
      wasOpen.current = false
    }
  }, [open, loading, targetsLoading])

  return triggerRef
}
