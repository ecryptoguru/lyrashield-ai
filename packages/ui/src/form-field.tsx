import { forwardRef } from "react"
import { cn } from "./utils"

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring",
        className
      )}
      {...props}
    />
  )
)
Input.displayName = "Input"

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring",
        className
      )}
      {...props}
    />
  )
)
Textarea.displayName = "Textarea"

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring",
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
