"use client"

import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button, FormField, Input, Spinner } from "@lyrashield/ui"
import { TARGET_NAME_LABEL } from "@/lib/terminology"

export function UrlTargetView({
  eyebrow,
  path,
  productName,
  onProductNameChange,
  url,
  ownershipAttested,
  onUrlChange,
  onOwnershipChange,
  loading,
  onBack,
  onSubmit,
}: {
  eyebrow: string
  path: "url" | "api"
  productName: string
  onProductNameChange: (name: string) => void
  url: string
  ownershipAttested: boolean
  onUrlChange: (url: string) => void
  onOwnershipChange: (attested: boolean) => void
  loading: boolean
  onBack: () => void
  onSubmit: () => void
}) {
  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <div>
        {/* Same step model as the progress list — the eyebrow and the
            highlighted item always describe the same step (v16 3.1). */}
        <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">{eyebrow}</p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">
          {path === "api" ? "Add your API" : "Add your app URL"}
        </h2>
        <p className="text-muted-foreground mt-2 text-sm">
          {path === "api"
            ? "Point LyraShield at the API's base URL. Scans run over HTTP against the public surface."
            : "Point LyraShield at the app's URL. Scans run over HTTP against the public surface."}{" "}
          You can connect GitHub later from Connections.
        </p>
      </div>

      {/* The name asked here is the name saved: the details step shows it
          read-only instead of asking again (v16 3.1). */}
      <FormField label={TARGET_NAME_LABEL} htmlFor="url-name">
        <Input
          id="url-name"
          disabled={loading}
          type="text"
          value={productName}
          onChange={(e) => onProductNameChange(e.target.value)}
          maxLength={100}
          autoFocus
          placeholder={path === "api" ? "Production API" : "Staging Site"}
        />
      </FormField>

      <FormField label="URL" htmlFor="url-input">
        <Input
          id="url-input"
          disabled={loading}
          type="url"
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder={path === "api" ? "https://api.example.com" : "https://staging.example.com"}
        />
      </FormField>

      <div className="flex items-start gap-2">
        <input
          id="ownership-check"
          disabled={loading}
          type="checkbox"
          name="ownershipAttested"
          checked={ownershipAttested}
          onChange={(e) => onOwnershipChange(e.target.checked)}
          required
          aria-required="true"
          aria-describedby="ownership-help"
          className="border-border text-primary focus:ring-ring mt-1 h-4 w-4 rounded focus:ring-2"
        />
        <div className="flex-1">
          <label htmlFor="ownership-check" className="text-sm">
            I own or am authorized to scan this target.
          </label>
          <p id="ownership-help" className="text-muted-foreground text-xs">
            This confirms you have permission to test this target.
          </p>
        </div>
      </div>

      <div className="flex justify-between gap-3">
        <Button type="button" variant="ghost" onClick={onBack} disabled={loading}>
          <ChevronLeft className="size-4" /> Back
        </Button>
        <Button type="submit" disabled={loading || !ownershipAttested}>
          {loading ? (
            <Spinner className="mr-2" />
          ) : (
            <ChevronRight className="size-4" aria-hidden="true" />
          )}
          Continue
        </Button>
      </div>
    </form>
  )
}
