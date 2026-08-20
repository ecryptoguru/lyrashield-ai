interface Props {
  label: string
  ok: boolean
  okText: string
  failText: string
  failHint?: string
}

export function StatusCard({ label, ok, okText, failText, failHint }: Props) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-border p-4">
      <div
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${
          ok ? "bg-success text-white" : "bg-destructive text-white"
        }`}
      >
        {ok ? "✓" : "✗"}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className={`text-xs ${ok ? "text-success" : "text-destructive"}`}>
          {ok ? okText : failText}
        </p>
        {!ok && failHint && <p className="text-xs text-muted-foreground">{failHint}</p>}
      </div>
    </div>
  )
}
