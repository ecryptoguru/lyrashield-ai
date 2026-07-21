import { describe, it, expect } from "vitest"
import {
  parseVulnerabilitiesJson,
  parseRunJson,
  parseEngineOutput,
  mapSeverity,
  generateDedupeKey,
  buildFindingSummary,
} from "./output-parser"

const SAMPLE_VULN = {
  id: "vuln-0001",
  title: "SQL Injection in login endpoint",
  severity: "critical",
  timestamp: "2026-07-05 12:00:00 UTC",
  target: "https://example.com",
  endpoint: "/api/login",
  method: "POST",
  cwe: "CWE-89",
  cve: "CVE-2026-1234",
  cvss: 9.8,
  description: "User input is directly concatenated into SQL query",
  impact: "Database compromise, data exfiltration",
  technical_analysis: "The login endpoint uses string concatenation for SQL queries",
  poc_description: "Send ' OR '1'='1 as username",
  poc_script_code: "curl -X POST https://example.com/api/login -d \"username=' OR '1'='1\"",
  remediation_steps: "Use parameterized queries",
  code_locations: [
    {
      file: "src/auth/login.ts",
      start_line: 42,
      end_line: 45,
      snippet: "const q = `SELECT * FROM users WHERE name='${username}'`",
    },
  ],
}

describe("output-parser", () => {
  describe("parseVulnerabilitiesJson", () => {
    it("parses valid JSON array", () => {
      const raw = JSON.stringify([SAMPLE_VULN])
      const result = parseVulnerabilitiesJson(raw)
      expect(result).toHaveLength(1)
      expect(result[0]?.id).toBe("vuln-0001")
      expect(result[0]?.title).toBe("SQL Injection in login endpoint")
    })

    it("retains only bounded Vibe Security control identifiers", () => {
      const raw = JSON.stringify([
        { ...SAMPLE_VULN, control_ids: [11, 11, 0, 51, 14, "3", "x", "05", " 10"] },
      ])

      expect(parseVulnerabilitiesJson(raw)[0]?.control_ids).toEqual([11, 14, 3, 5, 10])
    })

    it("parses control identifiers from a string list", () => {
      const raw = JSON.stringify([{ ...SAMPLE_VULN, control_ids: "11, 14; 27" }])

      expect(parseVulnerabilitiesJson(raw)[0]?.control_ids).toEqual([11, 14, 27])
    })

    it("parses control identifiers from a JSON array string", () => {
      const raw = JSON.stringify([{ ...SAMPLE_VULN, control_ids: '[11, "14", 0, "x", [3, 4]]' }])

      expect(parseVulnerabilitiesJson(raw)[0]?.control_ids).toEqual([11, 14, 3, 4])
    })

    it("retains bounded evidence and dependency context", () => {
      const result = parseVulnerabilitiesJson(
        JSON.stringify([
          {
            ...SAMPLE_VULN,
            evidence: "Confirmed from the installed lockfile",
            assumptions: "Package is present in the deployed build",
            fix_effort: "LOW",
            finding_class: "dependency_cve",
            cvss_breakdown: { attack_vector: "N" },
            dependency_metadata: { package_name: "example", package_ecosystem: "npm" },
          },
        ])
      )

      expect(result[0]).toMatchObject({
        evidence: "Confirmed from the installed lockfile",
        assumptions: "Package is present in the deployed build",
        fix_effort: "low",
        finding_class: "dependency_cve",
        cvss_breakdown: { attack_vector: "N" },
        dependency_metadata: { package_name: "example", package_ecosystem: "npm" },
      })
    })

    it("returns empty array for empty string", () => {
      expect(parseVulnerabilitiesJson("")).toEqual([])
      expect(parseVulnerabilitiesJson("   ")).toEqual([])
    })

    it("returns empty array for invalid JSON", () => {
      expect(parseVulnerabilitiesJson("not json")).toEqual([])
    })

    it("returns empty array for non-array JSON", () => {
      expect(parseVulnerabilitiesJson('{"key": "value"}')).toEqual([])
    })

    it("filters out non-object entries", () => {
      const raw = JSON.stringify([SAMPLE_VULN, "not an object", null, 42])
      const result = parseVulnerabilitiesJson(raw)
      expect(result).toHaveLength(1)
    })

    it("filters out objects without string id", () => {
      const raw = JSON.stringify([SAMPLE_VULN, { title: "no id" }, { id: 123 }])
      const result = parseVulnerabilitiesJson(raw)
      expect(result).toHaveLength(1)
    })

    it("defaults invalid severity to info", () => {
      const raw = JSON.stringify([{ ...SAMPLE_VULN, id: "v-bad-sev", severity: "super critical" }])
      const result = parseVulnerabilitiesJson(raw)
      expect(result).toHaveLength(1)
      expect(result[0]!.severity).toBe("info")
    })

    it("removes invalid CVSS scores", () => {
      const raw = JSON.stringify([{ ...SAMPLE_VULN, id: "v-bad-cvss", cvss: 15 }])
      const result = parseVulnerabilitiesJson(raw)
      expect(result).toHaveLength(1)
      expect(result[0]!.cvss).toBeUndefined()
    })

    it("normalizes CWE format", () => {
      const raw = JSON.stringify([{ ...SAMPLE_VULN, id: "v-cwe-num", cwe: "89" }])
      const result = parseVulnerabilitiesJson(raw)
      expect(result[0]!.cwe).toBe("CWE-89")
    })

    it("removes invalid CWE format", () => {
      const raw = JSON.stringify([{ ...SAMPLE_VULN, id: "v-bad-cwe", cwe: "not-a-cwe" }])
      const result = parseVulnerabilitiesJson(raw)
      expect(result[0]!.cwe).toBeUndefined()
    })

    it("filters out entries with missing title", () => {
      const raw = JSON.stringify([{ ...SAMPLE_VULN, id: "v-no-title", title: "" }])
      const result = parseVulnerabilitiesJson(raw)
      expect(result).toHaveLength(0)
    })

    it("rejects oversized finding collections and fields", () => {
      const tooMany = Array.from({ length: 1_001 }, (_, index) => ({
        ...SAMPLE_VULN,
        id: `v-${index}`,
      }))
      expect(parseVulnerabilitiesJson(JSON.stringify(tooMany))).toEqual([])
      expect(
        parseVulnerabilitiesJson(
          JSON.stringify([{ ...SAMPLE_VULN, description: "x".repeat(64 * 1024 + 1) }])
        )[0]?.description
      ).toBeUndefined()
    })
  })

  describe("parseRunJson", () => {
    it("parses valid run record", () => {
      const raw = JSON.stringify({
        run_id: "run-abc",
        run_name: "scan-123",
        start_time: "2026-07-05T12:00:00Z",
        end_time: "2026-07-05T12:30:00Z",
        status: "completed",
      })
      const result = parseRunJson(raw)
      expect(result).not.toBeNull()
      expect(result!.run_id).toBe("run-abc")
      expect(result!.status).toBe("completed")
    })

    it("retains bounded reproducibility metadata", () => {
      const result = parseRunJson(
        JSON.stringify({
          run_id: "run-meta",
          status: "completed",
          engine_version: "1.1.0",
          prompt_bundle_hash: "a".repeat(64),
          model: "azure_ai/gpt-5.6-luna",
          reasoning_effort: "medium",
          max_output_tokens: 4096,
          max_agents: 2,
          scan_mode: "quick",
        })
      )

      expect(result).toMatchObject({
        engine_version: "1.1.0",
        prompt_bundle_hash: "a".repeat(64),
        model: "azure_ai/gpt-5.6-luna",
        reasoning_effort: "medium",
        max_output_tokens: 4096,
        max_agents: 2,
        scan_mode: "quick",
      })
    })

    it("returns null for empty string", () => {
      expect(parseRunJson("")).toBeNull()
    })

    it("returns null for invalid JSON", () => {
      expect(parseRunJson("not json")).toBeNull()
    })

    it("returns null for non-object JSON", () => {
      expect(parseRunJson('["array"]')).toBeNull()
    })

    it("rejects incomplete runs and retains only bounded data needed by the worker", () => {
      expect(parseRunJson(JSON.stringify({ run_id: "run-1" }))).toBeNull()
      expect(
        parseRunJson(
          JSON.stringify({
            run_id: "run-1",
            status: "completed",
            targets_info: [
              { details: { cloned_repo_path: "/tmp/strix_repos/run-1" }, ignored: "x" },
            ],
            llm_usage: {
              total_cost_usd: 1.25,
              prompt: "do not retain",
              requests: [
                {
                  usage: {
                    input_tokens: 100,
                    output_tokens: 20,
                    input_tokens_details: { cached_tokens: 40 },
                  },
                },
                { usage: { input_tokens: 50, output_tokens: 10 } },
              ],
            },
            scan_results: { untrusted: true },
          })
        )
      ).toEqual({
        run_id: "run-1",
        run_name: null,
        start_time: "",
        end_time: null,
        status: "completed",
        targets_info: [{ details: { cloned_repo_path: "/tmp/strix_repos/run-1" } }],
        llm_usage: {
          request_count: 2,
          input_tokens: 150,
          cached_input_tokens: 40,
          output_tokens: 30,
          total_tokens: 180,
          total_cost_usd: 1.25,
        },
      })
    })

    it("rejects usage values that cannot fit the exact database ledger", () => {
      const result = parseRunJson(
        JSON.stringify({
          run_id: "run-bad-usage",
          status: "completed",
          llm_usage: {
            request_count: 1.5,
            input_tokens: 2_147_483_648,
            output_tokens: -1,
            total_cost_usd: 1_000_000,
          },
        })
      )

      expect(result?.llm_usage).toBeUndefined()
    })

    it("does not promote nested agent cost when provider cost is unavailable", () => {
      const result = parseRunJson(
        JSON.stringify({
          run_id: "run-native-cost-unavailable",
          status: "completed",
          llm_usage: {
            requests: 1,
            input_tokens: 100,
            output_tokens: 10,
            agents: [{ agent_id: "root", cost: 0 }],
          },
        })
      )

      expect(result?.llm_usage).toMatchObject({
        request_count: 1,
        input_tokens: 100,
        output_tokens: 10,
      })
      expect(result?.llm_usage).not.toHaveProperty("total_cost_usd")
    })

    it("does not retain partial usage totals from payloads beyond the traversal limit", () => {
      const requests = Array.from({ length: 600 }, () => ({ usage: { input_tokens: 1 } }))
      const result = parseRunJson(
        JSON.stringify({
          run_id: "run-wide-usage",
          status: "completed",
          llm_usage: { requests },
        })
      )

      expect(result?.llm_usage).toEqual({ request_count: 600 })
    })

    it("retains aggregate cache counters even when nested request usage is wide", () => {
      const requests = Array.from({ length: 600 }, () => ({ usage: { input_tokens: 1 } }))
      const result = parseRunJson(
        JSON.stringify({
          run_id: "run-cache-root",
          status: "completed",
          llm_usage: {
            requests,
            input_tokens: 2_725_857,
            output_tokens: 7_713,
            input_tokens_details: { cached_tokens: 1_700_000, cache_write_tokens: 10_000 },
          },
        })
      )

      expect(result?.llm_usage).toMatchObject({
        request_count: 600,
        input_tokens: 2_725_857,
        cached_input_tokens: 1_700_000,
        cache_write_input_tokens: 10_000,
        output_tokens: 7_713,
      })
    })

    it("retains cache-read totals when Azure omits cache-write receipts", () => {
      const result = parseRunJson(
        JSON.stringify({
          run_id: "run-cache-read-only",
          status: "completed",
          llm_usage: {
            requests: 2,
            input_tokens: 4_014,
            output_tokens: 63,
            request_usage_entries: [
              {
                model: "azure_ai/gpt-5.6-luna",
                input_tokens: 2_007,
                output_tokens: 31,
                input_tokens_details: { cached_tokens: 0 },
              },
              {
                model: "azure_ai/gpt-5.6-luna",
                input_tokens: 2_007,
                output_tokens: 32,
                input_tokens_details: { cached_tokens: 1_792 },
              },
            ],
          },
        })
      )

      expect(result?.llm_usage).toMatchObject({
        cached_input_tokens: 1_792,
      })
      expect(result?.llm_usage).not.toHaveProperty("cache_write_input_tokens")
      expect(result?.llm_usage).not.toHaveProperty("standard_input_tokens")
    })

    it("separates long-context request usage from standard request usage", () => {
      const result = parseRunJson(
        JSON.stringify({
          run_id: "run-pricing-buckets",
          status: "completed",
          llm_usage: {
            requests: 2,
            input_tokens: 300_100,
            output_tokens: 30,
            request_usage_entries: [
              {
                model: "azure_ai/gpt-5.6-terra",
                input_tokens: 100,
                output_tokens: 10,
                input_tokens_details: [{ cached_tokens: 20, cache_write_tokens: 0 }],
              },
              {
                model: "azure_ai/gpt-5.6-luna",
                input_tokens: 300_000,
                output_tokens: 20,
                input_tokens_details: [{ cached_tokens: 200_000, cache_write_tokens: 0 }],
              },
            ],
          },
        })
      )

      expect(result?.llm_usage).toMatchObject({
        standard_input_tokens: 100,
        standard_cached_input_tokens: 20,
        standard_output_tokens: 10,
        long_input_tokens: 300_000,
        long_cached_input_tokens: 200_000,
        long_output_tokens: 20,
        model_usage_buckets: [
          expect.objectContaining({
            model: "azure_ai/gpt-5.6-terra",
            standard_input_tokens: 100,
          }),
          expect.objectContaining({
            model: "azure_ai/gpt-5.6-luna",
            long_input_tokens: 300_000,
          }),
        ],
      })
    })
  })

  describe("parseEngineOutput", () => {
    it("combines vulnerabilities and run record", () => {
      const vulnsRaw = JSON.stringify([SAMPLE_VULN])
      const runRaw = JSON.stringify({ run_id: "r1", status: "completed", start_time: "now" })
      const result = parseEngineOutput(vulnsRaw, runRaw)
      expect(result.findingCount).toBe(1)
      expect(result.vulnerabilities).toHaveLength(1)
      expect(result.findingsComplete).toBe(true)
      expect(result.runRecord).not.toBeNull()
      expect(result.runRecord!.status).toBe("completed")
      expect(result.summary).toContain("1 finding")
    })

    it("handles empty outputs", () => {
      const result = parseEngineOutput("", "")
      expect(result.findingCount).toBe(0)
      expect(result.vulnerabilities).toEqual([])
      expect(result.findingsComplete).toBe(false)
      expect(result.runRecord).toBeNull()
      expect(result.summary).toContain("0 finding")
    })

    it("treats a valid empty artifact as complete", () => {
      const result = parseEngineOutput("[]", JSON.stringify({ status: "completed" }))
      expect(result.vulnerabilities).toEqual([])
      expect(result.findingsComplete).toBe(true)
    })
  })

  describe("mapSeverity", () => {
    it("maps lowercase severity to enum", () => {
      expect(mapSeverity("critical")).toBe("CRITICAL")
      expect(mapSeverity("high")).toBe("HIGH")
      expect(mapSeverity("medium")).toBe("MEDIUM")
      expect(mapSeverity("low")).toBe("LOW")
      expect(mapSeverity("info")).toBe("INFO")
    })

    it("maps uppercase severity to enum", () => {
      expect(mapSeverity("CRITICAL")).toBe("CRITICAL")
      expect(mapSeverity("HIGH")).toBe("HIGH")
    })

    it("defaults to INFO for unknown severity", () => {
      expect(mapSeverity("unknown")).toBe("INFO")
      expect(mapSeverity("")).toBe("INFO")
    })
  })

  describe("generateDedupeKey", () => {
    it("generates consistent key for same vulnerability", () => {
      const key1 = generateDedupeKey(SAMPLE_VULN, "target-1")
      const key2 = generateDedupeKey(SAMPLE_VULN, "target-1")
      expect(key1).toBe(key2)
    })

    it("generates different keys for different targets", () => {
      const key1 = generateDedupeKey(SAMPLE_VULN, "target-1")
      const key2 = generateDedupeKey(SAMPLE_VULN, "target-2")
      expect(key1).not.toBe(key2)
    })

    it("produces a 32-char hex string", () => {
      const key = generateDedupeKey(SAMPLE_VULN, "target-1")
      expect(key).toMatch(/^[a-f0-9]{32}$/)
    })

    it("does not collapse distinct code locations", () => {
      const first = generateDedupeKey(SAMPLE_VULN, "target-1")
      const second = generateDedupeKey(
        {
          ...SAMPLE_VULN,
          code_locations: [{ ...SAMPLE_VULN.code_locations[0], start_line: 100, end_line: 103 }],
        },
        "target-1"
      )
      expect(first).not.toBe(second)
    })

    it("correlates the same dependency CVE across independently worded scanners", () => {
      const engine = generateDedupeKey(
        {
          ...SAMPLE_VULN,
          title: "CVE in dependency",
          finding_class: "dependency_cve",
          dependency_metadata: { package_name: "lodash", package_ecosystem: "npm" },
        },
        "target-1"
      )
      const sca = generateDedupeKey(
        {
          ...SAMPLE_VULN,
          title: "Vulnerable dependency: lodash",
          finding_class: "dependency_cve",
          dependency_metadata: { package_name: "lodash", package_ecosystem: "npm" },
        },
        "target-1"
      )
      expect(engine).toBe(sca)
    })
  })

  describe("buildFindingSummary", () => {
    it("builds summary from endpoint, method, cwe", () => {
      const summary = buildFindingSummary(SAMPLE_VULN)
      expect(summary).toContain("Endpoint: /api/login")
      expect(summary).toContain("Method: POST")
      expect(summary).toContain("CWE: CWE-89")
    })

    it("falls back to title when no metadata", () => {
      const summary = buildFindingSummary({
        id: "v1",
        title: "Some vuln",
        severity: "low",
        timestamp: "now",
      })
      expect(summary).toBe("Some vuln")
    })

    it("truncates long descriptions", () => {
      const longDesc = "A".repeat(300)
      const summary = buildFindingSummary({
        id: "v1",
        title: "Test",
        severity: "low",
        timestamp: "now",
        description: longDesc,
      })
      expect(summary.length).toBeLessThan(longDesc.length + 100)
    })
  })
})
