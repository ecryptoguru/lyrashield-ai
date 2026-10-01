import { env } from "@lyrashield/config"
import {
  DEFAULT_STEP_TIMEOUT_MS,
  assertFailureInjectionAuthorization,
  type LaunchAssuranceDeps,
  type LaunchAssuranceOptions,
  type LaunchAssuranceReceipt,
} from "./verify-launch-assurance-contract"
import {
  finalizeReceipt,
  runAzureAlertReadbackStep,
  runFailureInjectionPhase,
  runProvenanceStep,
  runReadinessStep,
  runStorageProofPhase,
  type LaunchAssuranceRunContext,
} from "./verify-launch-assurance-phases"

/**
 * Orchestrate the launch-assurance gates in a fixed order. Each phase appends
 * its StepRecords to the shared context; the receipt is assembled once at the
 * end so cleanup and verdict logic live in exactly one place.
 *
 * Coherent responsibilities live in verify-launch-assurance-phases.ts:
 *   runProvenanceStep / runReadinessStep / runAzureAlertReadbackStep — read-only gates
 *   runStorageProofPhase — disposable-container evidence proofs
 *   runFailureInjectionPhase — full-mode injection/cancel/settle/recover sequence
 *   finalizeReceipt — container cleanup and verdict
 */
export async function verifyLaunchAssurance(
  options: LaunchAssuranceOptions,
  deps: LaunchAssuranceDeps
): Promise<LaunchAssuranceReceipt> {
  if (options.allowFailureInjection) assertFailureInjectionAuthorization(options)
  const mode: LaunchAssuranceReceipt["mode"] = options.allowFailureInjection
    ? "full"
    : options.allowStorageProof
      ? "storage-proof"
      : "dry-run"

  const ctx: LaunchAssuranceRunContext = {
    options,
    deps,
    mode,
    stepTimeoutMs: options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    startedAt: deps.now(),
    provenance: deps.resolveProvenance(),
    apiBase: (
      options.apiBaseUrl ??
      env.LYRASHIELD_API_URL ??
      env.NEXT_PUBLIC_APP_URL ??
      ""
    ).replace(/\/$/, ""),
    apiKey: options.apiKey ?? env.LYRASHIELD_API_KEY,
    steps: [],
    removedContainers: [],
    storageContainerNames: [],
  }

  // 1–3. Read-only gates
  await runProvenanceStep(ctx)
  await runReadinessStep(ctx)
  await runAzureAlertReadbackStep(ctx)

  // 4–5. Evidence storage proofs (mutation; disposable containers only)
  await runStorageProofPhase(ctx)

  // 6–10. Failure injection, cancellation, settle, queue recovery, readiness
  await runFailureInjectionPhase(ctx)

  return finalizeReceipt(ctx)
}
