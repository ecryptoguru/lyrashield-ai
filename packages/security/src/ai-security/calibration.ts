import { createHash } from "node:crypto"
import { AI_SECURITY_DETECTOR_VERSION } from "./types"
import { AI_SECURITY_FIXTURES } from "./fixtures"
import { scanAiSecurityFiles } from "./scan"

const LIMITS = {
  maxFiles: 25,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
  maxWallTimeMs: 30_000,
} as const

export const AI_SECURITY_CALIBRATION_CORPUS_VERSION = "ai-app-security-fixtures/1.0.0" as const

export type AiSecurityCalibrationReport = {
  corpusVersion: typeof AI_SECURITY_CALIBRATION_CORPUS_VERSION
  detectorVersion: string
  totalCases: number
  correctStates: number
  falsePositives: number
  falseNegatives: number
  precision: number | null
  recall: number | null
  inconclusiveRate: number
  unsupportedRate: number
  duplicateRate: number
  byControl: Record<string, { total: number; correct: number }>
  outputChecksum: string
}

export function evaluateAiSecurityFixtures(): AiSecurityCalibrationReport {
  let correctStates = 0
  let falsePositives = 0
  let falseNegatives = 0
  let inconclusive = 0
  let unsupported = 0
  const byControl: AiSecurityCalibrationReport["byControl"] = {}

  for (const fixture of AI_SECURITY_FIXTURES) {
    const signal = scanAiSecurityFiles([fixture.file], { limits: LIMITS }).signals.find(
      (candidate) => candidate.controlId === fixture.controlId
    )
    const actual = signal?.state ?? "NOT_ASSESSED"
    const expected = fixture.expectedState
    if (actual === expected) correctStates++
    if (actual === "DETECTED" && expected !== "DETECTED") falsePositives++
    if (actual !== "DETECTED" && expected === "DETECTED") falseNegatives++
    if (actual === "INCONCLUSIVE") inconclusive++
    if (fixture.file.language === "unknown") unsupported++
    const control = byControl[fixture.controlId] ?? { total: 0, correct: 0 }
    control.total++
    if (actual === expected) control.correct++
    byControl[fixture.controlId] = control
  }

  const detected = AI_SECURITY_FIXTURES.filter(
    (fixture) => fixture.expectedState === "DETECTED"
  ).length
  const precision = detected + falsePositives === 0 ? null : detected / (detected + falsePositives)
  const recall = detected + falseNegatives === 0 ? null : detected / (detected + falseNegatives)
  const report = {
    corpusVersion: AI_SECURITY_CALIBRATION_CORPUS_VERSION,
    detectorVersion: AI_SECURITY_DETECTOR_VERSION,
    totalCases: AI_SECURITY_FIXTURES.length,
    correctStates,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    inconclusiveRate: inconclusive / AI_SECURITY_FIXTURES.length,
    unsupportedRate: unsupported / AI_SECURITY_FIXTURES.length,
    duplicateRate: 0,
    byControl,
  }
  return {
    ...report,
    outputChecksum: createHash("sha256").update(JSON.stringify(report)).digest("hex"),
  }
}
