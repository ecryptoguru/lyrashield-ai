"use client"

import { forwardRef, useId, useState } from "react"
import { Eye, EyeOff } from "lucide-react"
import { Input, cn } from "@lyrashield/ui"

export type PasswordInputProps = React.InputHTMLAttributes<HTMLInputElement>

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, id: idProp, ...props }, ref) => {
    const [show, setShow] = useState(false)
    const generatedId = useId()
    const inputId = idProp ?? generatedId

    return (
      <div className="relative">
        <Input
          ref={ref}
          {...props}
          id={inputId}
          type={show ? "text" : "password"}
          className={cn("pr-12", className)}
        />
        <button
          type="button"
          onClick={() => setShow((prev) => !prev)}
          aria-pressed={show}
          aria-controls={inputId}
          // WCAG 2.5.5: 44x44px hit area, centered on the icon, with safe spacing
          // from the input edge. The icon stays 20px for visual balance; the
          // transparent button provides the minimum target.
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute top-1/2 right-1.5 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-md focus:outline-none focus-visible:ring-2"
          aria-label={show ? "Hide password" : "Show password"}
        >
          {show ? (
            <EyeOff className="size-5" aria-hidden="true" />
          ) : (
            <Eye className="size-5" aria-hidden="true" />
          )}
        </button>
      </div>
    )
  }
)
PasswordInput.displayName = "PasswordInput"
