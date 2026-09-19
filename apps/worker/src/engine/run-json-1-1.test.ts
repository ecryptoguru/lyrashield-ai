/* eslint-disable security/detect-non-literal-fs-filename -- checked-in fixture paths only. */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it, expect } from "vitest"
import { parseEngineOutput, parseVulnerabilitiesJson } from "./output-parser"

const FIXTURE_DIR = join(__dirname, "fixtures")

function fixture(dir: string, name: string): string {
  return readFileSync(join(FIXTURE_DIR, dir, name), "utf8")
}

const V1_0_VULNS = () => fixture("run-json-1.0", "vulnerabilities.json")
const V1_0_RUN = () => fixture("run-json-1.0", "run.json")
const V1_1_VULNS = () => fixture("run-json-1.1", "vulnerabilities.json")
const V1_1_RUN = () => fixture("run-json-1.1", "run.json")
const V1_1_COVERAGE = () => fixture("run-json-1.1", "coverage.json")
const V1_1_THREAT_MODELS = () => fixture("run-json-1.1", "threat_models.json")
const V1_1_HTTP_EXCHANGES = () => fixture("run-json-1.1", "http_exchanges.json")

function artifacts(overrides: Partial<Record<string, string | null>> = {}) {
  return {
    coverageRaw: V1_1_COVERAGE(),
    threatModelsRaw: V1_1_THREAT_MODELS(),
    httpExchangesRaw: V1_1_HTTP_EXCHANGES(),
    ...overrides,
  }
}

describe("run.json 1.0 golden fixture", () => {
  it("parses a schema-1.0 artifact pair unchanged", () => {
    const result = parseEngineOutput(V1_0_VULNS(), V1_0_RUN())
    expect(result.runRecord).toMatchObject({
      run_id: "fixture-run-1-0",
      status: "completed",
      scan_mode: "quick",
      engine_version: "1.6.4",
      cleanup: { sandbox_removed: true },
    })
    expect(result.vulnerabilities).toHaveLength(1)
    expect(result.vulnerabilities[0]).toMatchObject({
      id: "vuln-1-0-0001",
      title: "Hardcoded API token in client config",
      cwe: "CWE-798",
      cvss: 7.5,
      fix_effort: "trivial",
      control_ids: [3, 37],
    })
    // A 1.0 record carries no 1.1 evidence fields.
    expect(result.vulnerabilities[0]).not.toHaveProperty("counterevidence")
    expect(result.vulnerabilities[0]).not.toHaveProperty("engine_confidence")
    expect(result.vulnerabilities[0]).not.toHaveProperty("fix_verification")
    expect(result.vulnerabilities[0]).not.toHaveProperty("http_exchange_ids")
    expect(result.vulnerabilities[0]).not.toHaveProperty("update_history")
    expect(result.ingestionIssues).toEqual([])
    expect(result.scopedCoverage).toBeNull()
    expect(result.threatModels).toBeNull()
    expect(result.httpExchangeExport).toBeNull()
  })
})

describe("run.json 1.1 golden fixture", () => {
  it("parses the run-level evidence stamps", () => {
    const result = parseEngineOutput(V1_1_VULNS(), V1_1_RUN(), artifacts())
    expect(result.runRecord).toMatchObject({
      schema_version: "1.1",
      run_id: "fixture-run-1-1",
      status: "completed",
      report_artifacts_revision: 4,
      evidence_export: { status: "exported", exchanges: 2 },
    })
  })

  it("carries every additive finding evidence field verbatim", () => {
    const result = parseEngineOutput(V1_1_VULNS(), V1_1_RUN(), artifacts())
    const finding = result.vulnerabilities.find((v) => v.id === "vuln-1-1-0001")
    expect(finding).toMatchObject({
      counterevidence: "A WAF rule could still block exploitation in production.",
      engine_confidence: "high",
      confidence_rationale: "The vulnerable sink is reachable and the payload round-trips.",
      severity_change_conditions: "Downgrade to medium if authentication precedes this handler.",
      fix_verification: {
        kind: "engine_attestation",
        statement: "The filing agent replayed the request and observed the bypass.",
        method: "proxy_replay",
        evidence_refs: ["42"],
      },
      contextual_cvss_reasoning: "No authentication precedes the endpoint; impact is data-scoped.",
      advisory_cvss: {
        score: 8.6,
        vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/C:H/I:H/A:H",
        source: "engine_analysis",
        metric_reasoning: "Unauthenticated remote reach with full data impact.",
      },
      http_exchange_ids: ["42", "43"],
      update_history: [
        {
          timestamp: "2026-09-10 11:04:00 UTC",
          fields: ["cvss", "severity"],
          reason: "Confirmed unauthenticated reachability via exchange 42.",
          agent_id: "agent-101",
          agent_name: "vulnerability-scanner",
          previous_severity: "medium",
          previous_cvss: 6.5,
        },
      ],
      updated_at: "2026-09-10 11:04:00 UTC",
      evidence_warnings: ["poc script omitted from verbatim ledger"],
      evidence_contract_version: "1.1",
      engine_verification_state: "engine_asserted",
    })
  })

  it("never carries engine verification claims into the parsed finding", () => {
    const result = parseEngineOutput(V1_1_VULNS(), V1_1_RUN(), artifacts())
    const finding = result.vulnerabilities.find((v) => v.id === "vuln-1-1-0001")
    const keys = Object.keys(finding ?? {})
    for (const claim of [
      "verified",
      "verified_at",
      "verified_by",
      "poc_verified",
      "execution_evidence",
      "runtime_proof",
      "verification_state",
    ]) {
      expect(keys).not.toContain(claim)
    }
    // The engine's declared state survives only as verbatim evidence.
    expect(finding?.engine_verification_state).toBe("engine_asserted")
  })

  it("normalizes a bare advisory_cvss score into the structured form", () => {
    const result = parseEngineOutput(V1_1_VULNS(), V1_1_RUN(), artifacts())
    const dep = result.vulnerabilities.find((v) => v.id === "vuln-1-1-0002")
    expect(dep?.advisory_cvss).toEqual({ score: 7.5 })
    expect(dep?.dependency_metadata?.advisory_cvss).toBe(7.5)
  })

  it("keeps structured dependency_metadata values without flattening", () => {
    const result = parseEngineOutput(V1_1_VULNS(), V1_1_RUN(), artifacts())
    const dep = result.vulnerabilities.find((v) => v.id === "vuln-1-1-0002")
    expect(dep?.dependency_metadata).toMatchObject({
      package_name: "acme-orm",
      installed_version: "4.2.0",
      contextual_cvss_score: 6.1,
      cvss_breakdown: { attack_vector: "N", attack_complexity: "L" },
    })
  })

  it("validates http_exchange_ids against the exported exchange index", () => {
    const result = parseEngineOutput(V1_1_VULNS(), V1_1_RUN(), artifacts())
    const finding = result.vulnerabilities.find((v) => v.id === "vuln-1-1-0001")
    expect(finding?.http_exchange_ids).toEqual(["42", "43"])
    // Exchange 999999 is in missing_request_ids but never exported — the ref
    // is dropped and the drop is explicit.
    const dep = result.vulnerabilities.find((v) => v.id === "vuln-1-1-0002")
    expect(dep?.http_exchange_ids).toBeUndefined()
    expect(dep?.http_exchange_refs_dropped).toBe(true)
    expect(result.ingestionIssues.some((i) => i.includes("999999"))).toBe(true)
  })

  it("carries declared refs without validation when no artifact context exists", () => {
    // Standalone parse (no artifact context): refs are engine-asserted
    // evidence, carried but never treated as verified.
    const vulns = parseVulnerabilitiesJson(V1_1_VULNS())
    const finding = vulns.find((v) => v.id === "vuln-1-1-0002")
    expect(finding?.http_exchange_ids).toEqual(["999999"])
    expect(finding?.http_exchange_refs_dropped).toBeUndefined()
  })

  it("drops refs and warns when the exchange export is absent", () => {
    const result = parseEngineOutput(V1_1_VULNS(), V1_1_RUN(), {
      coverageRaw: undefined,
      threatModelsRaw: undefined,
      httpExchangesRaw: undefined,
    })
    const finding = result.vulnerabilities.find((v) => v.id === "vuln-1-1-0001")
    expect(finding?.http_exchange_ids).toBeUndefined()
    expect(finding?.http_exchange_refs_dropped).toBe(true)
    expect(result.ingestionIssues.some((i) => i.includes("exchange export unavailable"))).toBe(true)
  })

  it("treats an unreadable export as unavailable, never as proof", () => {
    const result = parseEngineOutput(V1_1_VULNS(), V1_1_RUN(), {
      coverageRaw: undefined,
      threatModelsRaw: undefined,
      httpExchangesRaw: null,
    })
    expect(result.httpExchangeExport).toBeNull()
    expect(result.ingestionIssues.some((i) => i.includes("http_exchanges.json unreadable"))).toBe(
      true
    )
  })

  it("parses the scoped coverage ledger into declared entries and gaps", () => {
    const result = parseEngineOutput(V1_1_VULNS(), V1_1_RUN(), artifacts())
    expect(result.scopedCoverage).not.toBeNull()
    expect(result.scopedCoverage?.schemaVersion).toBe("1")
    expect(result.scopedCoverage?.entries).toHaveLength(3)
    expect(result.scopedCoverage?.entries[0]).toMatchObject({
      id: "a1b2c3",
      subject: "src/auth/login.ts — SQL injection",
      outcome: "reported",
      reason: "vuln-1-1-0001",
      evidenceRefs: ["42"],
      recordedBy: "vulnerability-scanner",
      previousOutcomes: ["needs_follow_up"],
    })
    expect(result.scopedCoverage?.entries[2]?.outcome).toBe("needs_follow_up")
    expect(result.scopedCoverage?.gaps).toEqual([
      expect.objectContaining({ kind: "agent_recorded_no_coverage" }),
    ])
    expect(result.scopedCoverage?.completeness).toMatchObject({
      complete: false,
      caveats: ["Coverage reflects agent-reported entries only."],
    })
  })

  it("parses the threat-model document into a bounded canonical artifact", () => {
    const result = parseEngineOutput(V1_1_VULNS(), V1_1_RUN(), artifacts())
    expect(result.threatModels?.models).toHaveLength(1)
    expect(result.threatModels?.models[0]).toMatchObject({
      target: "https://app.example.com",
      writtenBy: "threat-model-agent",
      amendments: [{ at: expect.any(String), by: "vulnerability-scanner" }],
    })
    const doc = JSON.parse(result.threatModels!.document)
    expect(doc.models["https://app.example.com"].content).toContain("Trust Boundaries")
    expect(doc.models["https://app.example.com"].amendments).toHaveLength(1)
  })

  it("parses the exchange export into the cited-id index and canonical artifact", () => {
    const result = parseEngineOutput(V1_1_VULNS(), V1_1_RUN(), artifacts())
    expect(result.httpExchangeExport?.exchangeCount).toBe(2)
    expect(result.httpExchangeExport?.knownIds).toEqual(new Set(["42", "43"]))
    const doc = JSON.parse(result.httpExchangeExport!.document)
    expect(doc.binding.run_id).toBe("fixture-run-1-1")
    expect(doc.missing_request_ids).toEqual(["999999"])
    expect(doc.exchanges[0].request.headers.authorization).toBe("[REDACTED]")
  })
})

describe("run.json 1.1 reader bounds and failure modes", () => {
  const baseVuln = {
    id: "v-bounds",
    title: "Bounds probe",
    severity: "low",
    timestamp: "2026-09-10T00:00:00Z",
  }

  it("drops oversized or malformed evidence fields without dropping the finding", () => {
    const result = parseEngineOutput(
      JSON.stringify([
        {
          ...baseVuln,
          counterevidence: "x".repeat(10_001),
          confidence_rationale: "x".repeat(10_001),
          confidence: "absolute",
          advisory_cvss: { score: 42 },
          fix_verification: { statement: "" },
          update_history: [{ fields: [] }, "garbage", { timestamp: "t", fields: ["severity"] }],
          evidence_warnings: "not-a-list",
        },
      ]),
      V1_1_RUN(),
      artifacts()
    )
    const finding = result.vulnerabilities[0]
    expect(finding).toBeDefined()
    expect(finding).not.toHaveProperty("counterevidence")
    expect(finding).not.toHaveProperty("confidence_rationale")
    expect(finding).not.toHaveProperty("engine_confidence")
    expect(finding).not.toHaveProperty("advisory_cvss")
    expect(finding).not.toHaveProperty("fix_verification")
    expect(finding).not.toHaveProperty("evidence_warnings")
    // Valid revision entries survive; malformed ones drop individually.
    expect(finding?.update_history).toEqual([{ timestamp: "t", fields: ["severity"] }])
    expect(result.ingestionIssues.length).toBeGreaterThanOrEqual(5)
  })

  it("rejects unsupported run-record majors instead of guessing the contract", () => {
    const run = JSON.parse(V1_1_RUN())
    run.schema_version = "2.0"
    const result = parseEngineOutput(V1_1_VULNS(), JSON.stringify(run), artifacts())
    expect(result.runRecord).toBeNull()
    // Findings still parse — the vuln artifact is independent of run.json.
    expect(result.vulnerabilities.length).toBeGreaterThan(0)
  })

  it("keeps minor additive drift readable", () => {
    const run = JSON.parse(V1_1_RUN())
    run.schema_version = "1.9"
    const result = parseEngineOutput(V1_1_VULNS(), JSON.stringify(run), artifacts())
    expect(result.runRecord).toMatchObject({ schema_version: "1.9" })
  })

  it("ignores malformed sibling artifacts with explicit issues, not exceptions", () => {
    const result = parseEngineOutput(V1_1_VULNS(), V1_1_RUN(), {
      coverageRaw: "not json",
      threatModelsRaw: "{",
      httpExchangesRaw: '{"exchanges": "nope"}',
    })
    expect(result.scopedCoverage).toBeNull()
    expect(result.threatModels).toBeNull()
    expect(result.httpExchangeExport).toBeNull()
    expect(result.ingestionIssues.some((i) => i.includes("coverage.json"))).toBe(true)
    expect(result.ingestionIssues.some((i) => i.includes("threat_models.json"))).toBe(true)
    expect(result.ingestionIssues.some((i) => i.includes("http_exchanges.json"))).toBe(true)
  })

  it("drops malformed coverage entries without discarding the ledger", () => {
    const coverage = JSON.parse(V1_1_COVERAGE())
    coverage.entries.push(
      { id: "bad1", outcome: "bogus", surface: "x" },
      { id: "bad2", outcome: "reported" },
      "not an object"
    )
    const result = parseEngineOutput(V1_1_VULNS(), V1_1_RUN(), {
      coverageRaw: JSON.stringify(coverage),
    })
    expect(result.scopedCoverage?.entries).toHaveLength(3)
    expect(
      result.ingestionIssues.some((i) => i.includes("coverage.json") && i.includes("dropped"))
    ).toBe(true)
  })

  it("bounds the ingestion issue list so hostile artifacts cannot flood storage", () => {
    const vulns = Array.from({ length: 200 }, (_, i) => ({
      ...baseVuln,
      id: `v-${i}`,
      confidence: "bogus",
    }))
    const result = parseEngineOutput(JSON.stringify(vulns), V1_1_RUN(), artifacts())
    expect(result.ingestionIssues.length).toBeLessThanOrEqual(101)
    expect(result.ingestionIssues.at(-1)).toContain("truncated")
  })
})
