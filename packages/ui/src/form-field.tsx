import { forwardRef } from "react"
import { cn } from "./utils"

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "bg-background placeholder:text-muted-foreground/60 focus:ring-ring focus:border-primary/50 h-11 w-full rounded-lg border px-3 py-2 text-sm shadow-xs transition-[border-color,box-shadow] outline-none focus:ring-2",
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
      "bg-background placeholder:text-muted-foreground/60 focus:ring-ring focus:border-primary/50 w-full rounded-lg border px-3 py-2 text-sm shadow-xs transition-[border-color,box-shadow] outline-none focus:ring-2",
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
        "bg-background focus:ring-ring focus:border-primary/50 h-11 w-full rounded-lg border px-3 py-2 text-sm shadow-xs transition-[border-color,box-shadow] outline-none focus:ring-2",
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
}

export function FormField({ label, htmlFor, children, className }: FormFieldProps) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  )
}
