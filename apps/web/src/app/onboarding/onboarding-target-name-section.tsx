"use client"

import { FormField, Input } from "@lyrashield/ui"
import { TARGET_NAME_LABEL, TARGET_SINGULAR } from "@/lib/terminology"
import { pathLabel, pathNeedsRepo, type OnboardingPath } from "./onboarding-flow.utils"

export function TargetNameSection({
  path,
  productName,
  retryingExistingTarget,
  onProductNameChange,
}: {
  path: OnboardingPath
  productName: string
  retryingExistingTarget: boolean
  onProductNameChange: (name: string) => void
}) {
  if (retryingExistingTarget) {
    return (
      <div className="bg-muted/40 rounded-lg border p-4">
        <p className="text-sm font-medium">{productName || `Existing ${TARGET_SINGULAR}`}</p>
        <p className="text-muted-foreground mt-1 text-xs">
          Existing {pathLabel(path)} · target details are locked
        </p>
      </div>
    )
  }
  if (pathNeedsRepo(path)) {
    return (
      <FormField label={TARGET_NAME_LABEL} htmlFor="product-name">
        <Input
          id="product-name"
          value={productName}
          onChange={(e) => onProductNameChange(e.target.value)}
          placeholder="My web app"
        />
      </FormField>
    )
  }
  return (
    <div className="bg-muted/40 rounded-lg border p-4">
      <p className="text-muted-foreground text-xs font-medium">{TARGET_NAME_LABEL}</p>
      <p className="mt-1 text-sm font-medium">{productName || "Unnamed target"}</p>
    </div>
  )
}
