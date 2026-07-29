"use client"

import {
  forwardRef,
  useEffect,
  useState,
  type ReactNode,
  type ComponentPropsWithoutRef,
} from "react"
import { cn } from "@lyrashield/ui"
import { X } from "lucide-react"

export interface BottomSheetProps extends ComponentPropsWithoutRef<"div"> {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
}

export const BottomSheet = forwardRef<HTMLDivElement, BottomSheetProps>(
  ({ open, onClose, title, description, children, className, ...props }, ref) => {
    const [isOpen, setIsOpen] = useState(open)
    const [mounted, setMounted] = useState(open)

    useEffect(() => {
      if (open) {
        setMounted(true)
        const raf = requestAnimationFrame(() => requestAnimationFrame(() => setIsOpen(true)))
        return () => cancelAnimationFrame(raf)
      } else {
        setIsOpen(false)
        const timer = setTimeout(() => setMounted(false), 240)
        return () => clearTimeout(timer)
      }
    }, [open])

    if (!mounted) return null

    return (
      <div
        ref={ref}
        className="fixed inset-0 z-50 md:hidden"
        onClick={onClose}
        aria-modal="true"
        role="dialog"
        {...props}
      >
        <div
          className={cn(
            "absolute inset-0 bg-black/40 transition-opacity duration-320 ease-out",
            isOpen ? "opacity-100" : "opacity-0"
          )}
          aria-hidden="true"
        />
        <div
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "bg-background fixed right-0 bottom-0 left-0 max-h-[80vh] overflow-y-auto rounded-t-2xl border-t shadow-lg",
            "pb-[env(safe-area-inset-bottom)]",
            "transition-transform duration-320 ease-out",
            isOpen ? "translate-y-0" : "translate-y-full",
            className
          )}
        >
          <div className="bg-background sticky top-0 z-10 flex items-center justify-between border-b px-4 py-3">
            <div>
              <h2 className="text-base font-semibold" id="bottom-sheet-title">
                {title}
              </h2>
              {description ? (
                <p className="text-muted-foreground text-sm" id="bottom-sheet-description">
                  {description}
                </p>
              ) : null}
            </div>
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-md p-2 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              aria-label="Close"
            >
              <X className="size-5" aria-hidden="true" />
            </button>
          </div>
          <div
            className="px-4 py-4"
            aria-labelledby="bottom-sheet-title"
            aria-describedby={description ? "bottom-sheet-description" : undefined}
          >
            {children}
          </div>
        </div>
      </div>
    )
  }
)

BottomSheet.displayName = "BottomSheet"
