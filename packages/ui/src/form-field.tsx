import { Children, cloneElement, forwardRef, isValidElement } from "react"
import { cn } from "./utils"

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "bg-background placeholder:text-muted-foreground/60 focus:ring-ring focus:border-primary/50 h-11 w-full rounded-lg border px-3 py-2 text-sm max-md:text-base shadow-xs transition-[border-color,box-shadow] outline-none focus:ring-2",
        className
      )}
      {...props}
    />
  )
)
Input.displayName = "Input"

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "bg-background placeholder:text-muted-foreground/60 focus:ring-ring focus:border-primary/50 w-full rounded-lg border px-3 py-2 text-sm max-md:text-base shadow-xs transition-[border-color,box-shadow] outline-none focus:ring-2",
      className
    )}
    {...props}
  />
))
Textarea.displayName = "Textarea"

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "bg-background focus:ring-ring focus:border-primary/50 h-11 w-full rounded-lg border px-3 py-2 text-sm max-md:text-base shadow-xs transition-[border-color,box-shadow] outline-none focus:ring-2",
        className
      )}
      {...props}
    />
  )
)
Select.displayName = "Select"

interface FormFieldProps {
  label: string
  htmlFor: string
  children: React.ReactNode
  className?: string
  hint?: string
  error?: string
}

export function FormField({ label, htmlFor, children, className, hint, error }: FormFieldProps) {
  const hintId = `${htmlFor}-hint`
  const errorId = `${htmlFor}-error`
  const control =
    hint || error
      ? Children.map(children, (child) => {
          if (
            !isValidElement<{ id?: string; "aria-describedby"?: string }>(child) ||
            child.props.id !== htmlFor
          ) {
            return child
          }

          const descriptions = [
            ...new Set(
              [
                child.props["aria-describedby"],
                hint ? hintId : undefined,
                error ? errorId : undefined,
              ]
                .filter(Boolean)
                .join(" ")
                .split(/\s+/)
            ),
          ].join(" ")

          return cloneElement(child, {
            "aria-describedby": descriptions,
            ...(error ? { "aria-invalid": true } : {}),
          })
        })
      : children

  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {control}
      {hint ? (
        <p id={hintId} className="mt-1 text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="mt-1 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
