import { expectTypeOf } from "vitest"
import type { ScanEligibilityInput } from "../resources/scan-eligibility"
import type { CancelScanOptions, ScanInput } from "../resources/scans"

expectTypeOf<ScanInput>().toHaveProperty("engineBudgetCeilingUsd")
expectTypeOf<ScanEligibilityInput>().toHaveProperty("engineBudgetCeilingUsd")
expectTypeOf<CancelScanOptions>().not.toHaveProperty("engineBudgetCeilingUsd")
