import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it, expect } from "vitest"
import { engineVulnerabilitySchema } from "./engine-output-schema"
import { parseEngineOutput, generateDedupeKey } from "./output-parser"

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
  it("parses the complete schema-1.1 artifact tuple without promoting engine claims", () => {
    const result = parseEngineOutput(V1_1_VULNS(), V1_1_RUN(), artifacts())
    const finding = result.vulnerabilities.find((v) => v.id === "vuln-1-1-0001")
    const dep = result.vulnerabilities.find((v) => v.id === "vuln-1-1-0002")
    // Parses the run-level evidence stamps.
    expect(result.runRecord).toMatchObject({
      schema_version: "1.1",
      run_id: "fixture-run-1-1",
      status: "completed",
      prompt_cache: {
        enabled: true,
        routing_enabled: true,
        routing: "stable-prompt-v2",
        mode: "explicit",
        ttl: "30m",
      },
      report_artifacts_revision: 4,
      evidence_export: { status: "exported", exchanges: 2 },
    })

    // Carries every additive finding evidence field verbatim.
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

    // Never carries engine verification claims into the parsed finding.
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

    // Normalizes a bare advisory_cvss score into the structured form.
    expect(dep?.advisory_cvss).toEqual({ score: 7.5 })
    expect(dep?.dependency_metadata?.advisory_cvss).toBe(7.5)

    // Keeps structured dependency_metadata values without flattening.
    expect(dep?.dependency_metadata).toMatchObject({
      package_name: "acme-orm",
      installed_version: "4.2.0",
      contextual_cvss_score: 6.1,
      cvss_breakdown: { attack_vector: "N", attack_complexity: "L" },
    })

    // Validates http_exchange_ids against the exported exchange index.
    expect(finding?.http_exchange_ids).toEqual(["42", "43"])
    // Exchange 999999 is in missing_request_ids but never exported — the ref
    // is dropped and the drop is explicit.
    expect(dep?.http_exchange_ids).toBeUndefined()
    expect(dep?.http_exchange_refs_dropped).toBe(true)
    expect(result.ingestionIssues.some((i) => i.includes("999999"))).toBe(true)

    // Parses the scoped coverage ledger into declared entries and gaps.
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

    // Parses the threat-model document into a bounded canonical artifact.
    expect(result.threatModels?.models).toHaveLength(1)
    expect(result.threatModels?.models[0]).toMatchObject({
      target: "https://app.example.com",
      writtenBy: "threat-model-agent",
      amendments: [{ at: expect.any(String), by: "vulnerability-scanner" }],
    })
    const threatModelDocument = JSON.parse(result.threatModels!.document)
    expect(threatModelDocument.models["https://app.example.com"].content).toContain(
      "Trust Boundaries"
    )
    expect(threatModelDocument.models["https://app.example.com"].amendments).toHaveLength(1)

    // Parses the exchange export into the cited-id index and canonical artifact.
    expect(result.httpExchangeExport?.exchangeCount).toBe(2)
    expect(result.httpExchangeExport?.knownIds).toEqual(new Set(["42", "43"]))
    const exchangeDocument = JSON.parse(result.httpExchangeExport!.document)
    expect(exchangeDocument.binding.run_id).toBe("fixture-run-1-1")
    expect(exchangeDocument.missing_request_ids).toEqual(["999999"])
    expect(exchangeDocument.exchanges[0].request.headers.authorization).toBe("[REDACTED]")
  })

  it("carries declared refs without validation when no artifact context exists", () => {
    // Standalone parse (no artifact context): refs are engine-asserted
    // evidence, carried but never treated as verified.
    const vulns = parseEngineOutput(V1_1_VULNS(), V1_1_RUN()).vulnerabilities
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

  it("reads the owned engine threat_model.json models array", () => {
    const result = parseEngineOutput(V1_1_VULNS(), V1_1_RUN(), {
      ...artifacts(),
      threatModelsRaw: JSON.stringify({
        schema_version: "lyrashield-threat-model/1.0",
        generated_at: "2026-09-20 00:00:00 UTC",
        run_id: "fixture-run-1-1",
        run_name: "fixture",
        models: [
          {
            target: "https://app.example.com",
            written_at: "2026-09-20T00:00:00Z",
            written_by: "recon",
            content: "## Trust Boundaries\nPublic edge to app",
            amendments: [],
          },
        ],
        note: "Declared assumptions, not tested paths.",
      }),
    })

    expect(result.threatModels?.schemaVersion).toBe("lyrashield-threat-model/1.0")
    expect(result.threatModels?.models).toHaveLength(1)
    const document = JSON.parse(result.threatModels!.document)
    expect(document.models).toHaveLength(1)
    expect(document.run_id).toBe("fixture-run-1-1")
  })

  it("redacts secret assignments in a legacy threat model before persistence", () => {
    const result = parseEngineOutput(V1_1_VULNS(), V1_1_RUN(), {
      ...artifacts(),
      threatModelsRaw: JSON.stringify({
        "https://app.example.com": {
          target: "https://app.example.com/?password=sample-secret-123",
          written_at: "2026-09-20T00:00:00Z",
          written_by: "password=sample-secret-123",
          content: "password=sample-secret-123",
          amendments: [{ at: "today", by: "recon", content: "Bearer sample-secret-123" }],
        },
      }),
    })

    expect(result.threatModels).not.toBeNull()
    expect(JSON.stringify(result.threatModels)).not.toContain("sample-secret-123")
  })

  it("rejects a canonical threat model bound to another run", () => {
    const result = parseEngineOutput(V1_1_VULNS(), V1_1_RUN(), {
      ...artifacts(),
      threatModelsRaw: JSON.stringify({
        schema_version: "lyrashield-threat-model/1.0",
        generated_at: "2026-09-20 00:00:00 UTC",
        run_id: "different-run",
        models: [{ target: "https://app.example.com", content: "declared assumptions" }],
      }),
    })

    expect(result.threatModels).toBeNull()
    expect(result.ingestionIssues.some((issue) => issue.includes("run_id mismatch"))).toBe(true)
  })

  it("does not present a blank model as usable threat evidence", () => {
    const result = parseEngineOutput(V1_1_VULNS(), V1_1_RUN(), {
      ...artifacts(),
      threatModelsRaw: JSON.stringify({
        schema_version: "lyrashield-threat-model/1.0",
        generated_at: "2026-09-20 00:00:00 UTC",
        run_id: "fixture-run-1-1",
        models: [{ target: "https://app.example.com", content: "  \n  " }],
      }),
    })

    expect(result.threatModels).toBeNull()
    expect(result.ingestionIssues.some((issue) => issue.includes("no usable models"))).toBe(true)
  })

  it("rejects canonical threat evidence with an error or missing run binding", () => {
    const document = {
      schema_version: "lyrashield-threat-model/1.0",
      generated_at: "2026-09-20 00:00:00 UTC",
      run_id: "fixture-run-1-1",
      models: [{ target: "https://app.example.com", content: "Declared boundary" }],
    }
    const errored = parseEngineOutput(V1_1_VULNS(), V1_1_RUN(), {
      ...artifacts(),
      threatModelsRaw: JSON.stringify({ ...document, error: "mirror unreadable" }),
    })
    expect(errored.threatModels).toBeNull()

    const unbound = parseEngineOutput(V1_1_VULNS(), "{invalid", {
      ...artifacts(),
      threatModelsRaw: JSON.stringify(document),
    })
    expect(unbound.threatModels).toBeNull()
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
    expect(result.ingestionIssues.some((i) => i.includes("threat_model.json"))).toBe(true)
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

describe("run.json 1.2 pending exchange claims", () => {
  const finding = {
    id: "pending-finding",
    title: "Pending evidence",
    severity: "high" as const,
    timestamp: "t",
    evidence_contract_version: "1.2",
  }
  const parse = (pending: unknown, httpExchangesRaw: string | null = null) =>
    parseEngineOutput(
      JSON.stringify([{ ...finding, pending_http_exchange_ids: pending }]),
      JSON.stringify({ ...JSON.parse(V1_1_RUN()), schema_version: "1.2" }),
      { httpExchangesRaw }
    )

  it.each([
    { label: "unavailable", raw: null },
    { label: "exported", raw: V1_1_HTTP_EXCHANGES() },
  ])("retains pending claims without promoting them even when $label", ({ raw }) => {
    const result = parse(["42", "42", "99"], raw)
    expect(result.runRecord?.schema_version).toBe("1.2")
    expect(result.vulnerabilities[0]).toMatchObject({ pending_http_exchange_ids: ["42", "99"] })
    expect(result.vulnerabilities[0]).not.toHaveProperty("http_exchange_ids")
    expect(result.vulnerabilities[0]).not.toHaveProperty("verified")
    expect(generateDedupeKey(result.vulnerabilities[0]!, "target")).toBe(
      generateDedupeKey(finding, "target")
    )
  })

  it("bounds pending and exported refs independently", () => {
    const ids = Array.from({ length: 10 }, (_, i) => String(i))
    const result = engineVulnerabilitySchema.safeParse({
      ...finding,
      http_exchange_ids: ids,
      pending_http_exchange_ids: ids,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.pending_http_exchange_ids).toEqual(ids)
      expect(result.data.http_exchange_ids).toEqual(ids)
    }
  })

  it.each([{ value: "42" }, { value: Array.from({ length: 11 }, (_, i) => String(i)) }])(
    "rejects malformed or overflowing pending lists ($value)",
    ({ value }) => {
      const result = parse(value)
      expect(result.vulnerabilities[0]).not.toHaveProperty("pending_http_exchange_ids")
      expect(result.ingestionIssues.join(" ")).toContain("pending_http_exchange_ids")
    }
  )

  it("rejects non-ASCII, non-string, and oversized IDs while preserving bounded claims", () => {
    const result = parse(["４２", 42, "1".repeat(129), "1".repeat(128), "42"])
    expect(result.vulnerabilities[0]?.pending_http_exchange_ids).toEqual(["1".repeat(128), "42"])
    expect(result.ingestionIssues.join(" ")).toContain("pending_http_exchange_ids")
  })
})

describe("run.json 1.2 bound exported exchange references", () => {
  const vuln = {
    id: "bound-finding",
    evidence_contract_version: "1.2",
    target: "https://app.example.test/login",
    title: "Bound claim",
    severity: "high",
    timestamp: "t",
    http_exchange_ids: ["42"],
    pending_http_exchange_ids: ["99"],
    update_history: [{ timestamp: "t", fields: ["severity"] }],
  }
  const boundParse = (
    change: {
      binding?: Record<string, unknown>
      corruptManifest?: boolean
      corruptFindings?: boolean
      history?: unknown
      knownId?: string
      omitManifest?: boolean
      runRaw?: string
      runVersion?: string
      expectedRunName?: string
      outcome?: Record<string, unknown>
      exportSchema?: string
      request?: Record<string, unknown> | null
      missing?: string[]
      capacityOmitted?: string[]
      truncatedOmitted?: string[]
    } = {}
  ) => {
    const raw = JSON.stringify([
      { ...vuln, ...(change.history !== undefined ? { update_history: change.history } : {}) },
    ])
    const run = {
      ...JSON.parse(V1_1_RUN()),
      receipt_persisted: true,
      schema_version: change.runVersion ?? "1.2",
      evidence_export: { status: "exported", exchanges: 1, ...change.outcome },
    }
    const exported = JSON.stringify({
      schema_version: change.exportSchema ?? "lyrashield-http-exchanges/1.0",
      missing_request_ids: change.missing,
      capacity_omitted_request_ids: change.capacityOmitted,
      truncated: change.truncatedOmitted
        ? { omitted_request_ids: change.truncatedOmitted }
        : undefined,
      binding: {
        run_id: run.run_id,
        run_name: run.run_name,
        report_artifacts_revision: run.report_artifacts_revision,
        findings: { "bound-finding": ["42"] },
        finding_revisions: { "bound-finding": 1 },
        ...change.binding,
      },
      exchanges: [
        {
          proxy_request_id: change.knownId ?? "42",
          request:
            change.request === undefined
              ? { host: "app.example.test", sha256: "a".repeat(64) }
              : change.request,
        },
      ],
    })
    run.evidence_export = {
      status: "exported",
      exchanges: 1,
      artifact: "http_exchanges.json",
      sha256: createHash("sha256").update(exported).digest("hex"),
      ...change.outcome,
    }
    const entry = (path: string, content: string) => ({
      path,
      bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    })
    run.result_manifest = change.omitManifest
      ? undefined
      : {
          schema_version: 1,
          artifacts: {
            "http_exchanges.json": entry(
              "http_exchanges.json",
              change.corruptManifest ? "changed" : exported
            ),
            "vulnerabilities.json": entry(
              "vulnerabilities.json",
              change.corruptFindings ? "changed" : raw
            ),
          },
        }
    return parseEngineOutput(
      raw,
      change.runRaw ?? JSON.stringify(run),
      { httpExchangesRaw: exported },
      change.expectedRunName ? { expectedRunName: change.expectedRunName } : undefined
    )
  }

  it("accepts exact manifest/run/finding/revision-bound refs without promoting pending claims", () => {
    const result = boundParse()
    expect(result.vulnerabilities[0]?.http_exchange_ids).toEqual(["42"])
    expect(result.vulnerabilities[0]?.pending_http_exchange_ids).toEqual(["99"])
    expect(result.vulnerabilities[0]).not.toHaveProperty("verified")
  })

  it("preserves valid individually bound refs on a partial export", () => {
    expect(
      boundParse({ outcome: { status: "partial", exchanges: 1 }, missing: ["99"] })
        .vulnerabilities[0]?.http_exchange_ids
    ).toEqual(["42"])
  })

  it.each([
    { label: "foreign run", binding: { run_id: "another-run" } },
    { label: "foreign run name", binding: { run_name: "another-name" } },
    { label: "stale report revision", binding: { report_artifacts_revision: 0 } },
    { label: "foreign finding", binding: { findings: { another: ["42"] } } },
    { label: "stale finding revision", binding: { finding_revisions: { "bound-finding": 0 } } },
    { label: "missing finding revision", binding: { finding_revisions: undefined } },
    { label: "unknown exchange", knownId: "43" },
    { label: "changed export", corruptManifest: true },
    { label: "changed findings", corruptFindings: true },
    { label: "wrong finding refs", binding: { findings: { "bound-finding": ["99"] } } },
    {
      label: "malformed revision history",
      binding: { finding_revisions: { "bound-finding": 0 } },
      history: ["invalid"],
    },
    { label: "missing manifest", omitManifest: true },
    { label: "malformed run", runRaw: "{" },
    { label: "missing run", runRaw: "" },
    { label: "downgraded run", runVersion: "1.1" },
    { label: "foreign worker run", expectedRunName: "expected-worker-run" },
    { label: "failed export", outcome: { status: "failed", exchanges: 0 } },
    { label: "skipped export", outcome: { status: "skipped", exchanges: 1 } },
    { label: "zero exchanges", outcome: { status: "exported", exchanges: 0 } },
    { label: "unknown export schema", exportSchema: "unknown" },
    { label: "index-only exchange", request: null },
    { label: "missing request hash", request: { host: "app.example.test" } },
    {
      label: "foreign request host",
      request: { host: "foreign.example.test", sha256: "a".repeat(64) },
    },
    { label: "explicit missing ID", missing: ["42"] },
    { label: "explicit capacity-omitted ID", capacityOmitted: ["42"] },
    { label: "explicit truncated ID", truncatedOmitted: ["42"] },
    { label: "outcome missing ID", outcome: { missing_request_ids: ["42"] } },
  ])("drops $label refs while retaining unresolved claims", (change) => {
    const result = boundParse(change)
    if (!change.expectedRunName)
      expect(result.vulnerabilities[0]).not.toHaveProperty("http_exchange_ids")
    if (change.expectedRunName) {
      expect(result.vulnerabilities).toEqual([])
      expect(result.httpExchangeExport).toBeNull()
      expect(result.findingsComplete).toBe(false)
    } else {
      expect(result.vulnerabilities[0]?.http_exchange_refs_dropped).toBe(true)
      expect(result.vulnerabilities[0]?.pending_http_exchange_ids).toEqual(["99"])
    }
    expect(result.ingestionIssues.length).toBeGreaterThan(0)
  })
})

describe("actual 1.2 writer artifact tuple", () => {
  it.each([
    { verified: 10, pending: 1 },
    { verified: 1, pending: 10 },
  ])(
    "retains independent field bounds with $verified captured and $pending pending IDs",
    ({ verified, pending }) => {
      const run = JSON.parse(fixture("run-json-1.2", "run.json"))
      const findings = JSON.parse(fixture("run-json-1.2", "vulnerabilities.json"))
      const exported = JSON.parse(fixture("run-json-1.2", "http_exchanges.json"))
      const ids = Array.from({ length: verified }, (_, index) => String(index + 1))
      const unresolved = Array.from({ length: pending }, (_, index) => String(index + 101))
      findings[0].http_exchange_ids = ids
      findings[0].pending_http_exchange_ids = unresolved
      const selected = [...ids, ...unresolved].slice(0, 10)
      const omitted = unresolved.filter((id) => !selected.includes(id))
      exported.binding.findings[findings[0].id] = selected
      exported.exchanges = ids.map((id) => ({ ...exported.exchanges[0], proxy_request_id: id }))
      exported.missing_request_ids = unresolved.filter((id) => selected.includes(id))
      exported.capacity_omitted_request_ids = omitted
      run.evidence_export = {
        status: "partial",
        exchanges: ids.length,
        missing_request_ids: exported.missing_request_ids,
        capacity_omitted_request_ids: omitted,
      }
      const raw = JSON.stringify(findings)
      const exportRaw = JSON.stringify(exported)
      run.evidence_export.artifact = "http_exchanges.json"
      run.evidence_export.sha256 = createHash("sha256").update(exportRaw).digest("hex")
      for (const [path, content] of [
        ["vulnerabilities.json", raw],
        ["http_exchanges.json", exportRaw],
      ] as const) {
        run.result_manifest.artifacts[path] = {
          path,
          bytes: Buffer.byteLength(content),
          sha256: createHash("sha256").update(content).digest("hex"),
        }
      }
      const result = parseEngineOutput(
        raw,
        JSON.stringify(run),
        { httpExchangesRaw: exportRaw },
        { expectedRunName: "task5-writer-fixture" }
      )
      expect(result.vulnerabilities[0]?.http_exchange_ids).toEqual(ids)
      expect(result.vulnerabilities[0]?.pending_http_exchange_ids).toEqual(unresolved)
      expect(result.ingestionIssues).toEqual([])
    }
  )

  it.each(["schema", "host", "request hash"])(
    "rejects actual writer bytes with a contradictory %s even after rebinding the manifest",
    (change) => {
      const run = JSON.parse(fixture("run-json-1.2", "run.json"))
      const exported = JSON.parse(fixture("run-json-1.2", "http_exchanges.json"))
      if (change === "schema") exported.schema_version = "unknown"
      if (change === "host") exported.exchanges[0].request.host = "foreign.example.test"
      if (change === "request hash") exported.exchanges[0].request.sha256 = "invalid"
      const raw = JSON.stringify(exported)
      run.evidence_export.sha256 = createHash("sha256").update(raw).digest("hex")
      run.result_manifest.artifacts["http_exchanges.json"] = {
        path: "http_exchanges.json",
        bytes: Buffer.byteLength(raw),
        sha256: createHash("sha256").update(raw).digest("hex"),
      }
      const result = parseEngineOutput(
        fixture("run-json-1.2", "vulnerabilities.json"),
        JSON.stringify(run),
        { httpExchangesRaw: raw },
        { expectedRunName: "task5-writer-fixture" }
      )
      expect(result.vulnerabilities[0]).not.toHaveProperty("http_exchange_ids")
      expect(result.vulnerabilities[0]?.pending_http_exchange_ids).toEqual(["18"])
      expect(result.vulnerabilities[0]?.http_exchange_refs_dropped).toBe(true)
    }
  )

  it("accepts captured reference17 and retains unresolved18 on partial export", () => {
    const result = parseEngineOutput(
      fixture("run-json-1.2", "vulnerabilities.json"),
      fixture("run-json-1.2", "run.json"),
      { httpExchangesRaw: fixture("run-json-1.2", "http_exchanges.json") },
      { expectedRunName: "task5-writer-fixture" }
    )
    expect(result.vulnerabilities[0]).toMatchObject({
      http_exchange_ids: ["17"],
      pending_http_exchange_ids: ["18"],
      engine_verification_state: "unverified",
    })
    expect(result.ingestionIssues).toEqual([])
  })
})

describe("1.2 export document qualification before persistence", () => {
  const actual = (change: string) => {
    const run = JSON.parse(fixture("run-json-1.2", "run.json"))
    const findings = JSON.parse(fixture("run-json-1.2", "vulnerabilities.json"))
    const exported = JSON.parse(fixture("run-json-1.2", "http_exchanges.json"))
    if (change === "foreign sibling") {
      exported.binding.run_id = exported.binding.run_name = "other-run"
      exported.exchanges[0].request.body_sample = "foreign capture content"
    }
    if (change === "stale sibling") exported.binding.report_artifacts_revision = 0
    if (change === "missing overflow")
      run.evidence_export.missing_request_ids = [
        ...Array.from({ length: 500 }, (_, i) => String(i + 1000)),
        "17",
      ]
    if (change === "capacity overflow")
      run.evidence_export.capacity_omitted_request_ids = [
        ...Array.from({ length: 500 }, (_, i) => String(i + 1000)),
        "17",
      ]
    if (change === "malformed missing") run.evidence_export.missing_request_ids = ["bad", "17"]
    if (change === "malformed capacity") run.evidence_export.capacity_omitted_request_ids = "17"
    if (change === "mixed partial") findings[0].http_exchange_ids = ["17", "18"]
    const raw = JSON.stringify(findings)
    const exportRaw = JSON.stringify(exported)
    for (const [path, content] of [
      ["vulnerabilities.json", raw],
      ["http_exchanges.json", exportRaw],
    ] as const) {
      run.result_manifest.artifacts[path] = {
        path,
        bytes: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
      }
    }
    run.evidence_export.sha256 = run.result_manifest.artifacts["http_exchanges.json"].sha256
    if (change === "manifest mismatch")
      run.result_manifest.artifacts["http_exchanges.json"].sha256 = "0".repeat(64)
    if (change === "outcome mismatch") run.evidence_export.sha256 = "1".repeat(64)
    if (change === "missing outcome digest") delete run.evidence_export.sha256
    return parseEngineOutput(
      raw,
      JSON.stringify(run),
      { httpExchangesRaw: exportRaw },
      { expectedRunName: "task5-writer-fixture" }
    )
  }

  it.each([
    "foreign sibling",
    "stale sibling",
    "manifest mismatch",
    "outcome mismatch",
    "missing outcome digest",
    "missing overflow",
    "capacity overflow",
    "malformed missing",
    "malformed capacity",
  ])("quarantines $0 while retaining pending findings", (change) => {
    const result = actual(change)
    expect(result.httpExchangeExport).toBeNull()
    expect(result.vulnerabilities[0]).not.toHaveProperty("http_exchange_ids")
    expect(result.vulnerabilities[0]?.pending_http_exchange_ids).toEqual(["18"])
    expect(result.ingestionIssues.length).toBeGreaterThan(0)
  })

  it("retains captured17 when the same finding also cites explicitly missing18", () => {
    const result = actual("mixed partial")
    expect(result.httpExchangeExport).not.toBeNull()
    expect(result.vulnerabilities[0]).toMatchObject({
      http_exchange_ids: ["17"],
      http_exchange_refs_dropped: true,
      pending_http_exchange_ids: ["18"],
    })
    expect(result.ingestionIssues.length).toBeGreaterThan(0)
  })
})
