import { useCallback, useState } from "react"
import { EngineBudgetCeilingTextSchema } from "@lyrashield/types"
import { ChevronDown } from "lucide-react"
import { FormField, Input, cn } from "@lyrashield/ui"
import { getScanModeLabel } from "@/lib/enum-labels"
import { supportsEngineSpendingLimit, type ManualScanOption } from "@/lib/scan-presets"

export function useEngineBudgetDraft(principalId: string, workspaceId: string) {
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [draft, setDraft] = useState({ principalId, workspaceId, text: "" })
  const engineBudgetCeiling =
    draft.principalId === principalId && draft.workspaceId === workspaceId ? draft.text : ""
  const setEngineBudgetCeiling = useCallback(
    (text: string) => setDraft({ principalId, workspaceId, text }),
    [principalId, workspaceId]
  )
  const prepareEngineBudget = useCallback(
    (value: string) => {
      setEngineBudgetCeiling(value)
      if (value) setShowAdvanced(true)
    },
    [setEngineBudgetCeiling]
  )
  return {
    engineBudgetCeiling,
    setEngineBudgetCeiling,
    prepareEngineBudget,
    showAdvanced,
    setShowAdvanced,
  }
}

export function parseEngineBudgetField(
  text: string,
  option?: ManualScanOption
): { value?: number; error?: string } {
  if (!text.trim()) return {}
  if (!supportsEngineSpendingLimit(option))
    return {
      error:
        option?.workflow === "AUTHENTICATED_ASSESSMENT"
          ? "Clear the engine spending limit to start an authenticated assessment."
          : "Clear the engine spending limit to start a deterministic review.",
    }
  const parsed = EngineBudgetCeilingTextSchema.safeParse(text)
  return parsed.success ? { value: parsed.data } : { error: "Enter an amount greater than zero." }
}

export function ScanAdvancedOptions({
  selectedOption,
  showAdvanced,
  setShowAdvanced,
  engineBudgetCeiling,
  setEngineBudgetCeiling,
}: {
  selectedOption?: ManualScanOption
  showAdvanced: boolean
  setShowAdvanced: (show: boolean) => void
  engineBudgetCeiling: string
  setEngineBudgetCeiling: (value: string) => void
}) {
  const budget = parseEngineBudgetField(engineBudgetCeiling, selectedOption)
  return (
    <div>
      <button
        type="button"
        onClick={() => setShowAdvanced(!showAdvanced)}
        aria-expanded={showAdvanced}
        aria-controls="scan-advanced-panel"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-11 items-center gap-1 rounded-md px-1 text-xs font-medium focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none"
      >
        <ChevronDown
          className={cn(
            "size-4 transition-transform duration-(--duration-fast) ease-out",
            showAdvanced ? "rotate-180" : ""
          )}
          aria-hidden="true"
        />
        Review details and spending limit
        {!showAdvanced && budget.value !== undefined ? ` · USD ${budget.value}` : null}
      </button>

      {!showAdvanced && budget.error && (
        <p role="alert" className="mt-1 text-sm">
          {budget.error} Open review details to edit it.
        </p>
      )}
      {showAdvanced && selectedOption && (
        <div
          id="scan-advanced-panel"
          className="bg-muted/40 border-border mt-2 rounded-lg border p-4"
        >
          {(supportsEngineSpendingLimit(selectedOption) || engineBudgetCeiling) && (
            <FormField
              className="mb-4"
              label="Engine spending limit (USD)"
              htmlFor="scan-engine-budget"
              hint="Optional. Caps the scan engine for this review. Other analysis may have separate costs."
              error={budget.error}
            >
              <Input
                id="scan-engine-budget"
                inputMode="decimal"
                autoComplete="off"
                value={engineBudgetCeiling}
                aria-invalid={Boolean(budget.error)}
                onChange={(event) => setEngineBudgetCeiling(event.target.value)}
              />
            </FormField>
          )}
          <dl className="space-y-3 text-xs leading-relaxed">
            <div>
              <dt className="text-sm font-medium">What this review covers</dt>
              <dd className="text-muted-foreground mt-1">{selectedOption.hint}</dd>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground font-medium">Workflow</dt>
                <dd>
                  {selectedOption.workflow === "REVIEW_CHANGES" ? "Scan changes" : "Scan target"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground font-medium">Depth</dt>
                <dd>{getScanModeLabel(selectedOption.mode)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground font-medium">Effective scope</dt>
                <dd>{selectedOption.scopeSummary}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground font-medium">Limits</dt>
                <dd>{selectedOption.limitsSummary}</dd>
              </div>
            </div>
            <div>
              <dt className="text-muted-foreground font-medium">Applicable checks</dt>
              <dd>
                <ul className="text-muted-foreground mt-1 list-inside list-disc">
                  {selectedOption.applicableChecks.map((check) => (
                    <li key={check}>{check}</li>
                  ))}
                </ul>
              </dd>
            </div>
            {selectedOption.authorizationHint ? (
              <div>
                <dt className="text-muted-foreground font-medium">Authorization required</dt>
                <dd className="text-muted-foreground">{selectedOption.authorizationHint}</dd>
              </div>
            ) : null}
            <dd className="text-muted-foreground">
              The completed scan records the applicable evidence and any limitations so you can
              decide what to fix or retest next.
            </dd>
          </dl>
        </div>
      )}
    </div>
  )
}
