import {
  authorizeDeterministicRetest,
  RetestBaselineUnavailableError,
} from "./deterministic-retest"
import { inconclusiveRetestsForScan } from "./result-integrity"

/**
 * Authorize a deterministic retest, recording an inconclusive receipt when the
 * baseline cannot be established. That refusal is expected (for example an
 * originating scan with partial coverage) and must not read as an internal
 * service failure. The finding still never becomes FIXED.
 */
export async function authorizeDeterministicRetestOrInconclusive(
  scanId: string,
  workspaceId: string,
  targetId: string
): Promise<void> {
  try {
    await authorizeDeterministicRetest(scanId, workspaceId, targetId)
  } catch (error) {
    if (!(error instanceof RetestBaselineUnavailableError)) throw error
    await inconclusiveRetestsForScan(scanId, error.reason)
    throw error
  }
}
