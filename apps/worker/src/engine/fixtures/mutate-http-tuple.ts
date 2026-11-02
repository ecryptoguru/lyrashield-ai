import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { parseEngineOutput } from "../output-parser"

/** Change synthetic writer bytes and recompute both digests as the writer would. */
export function parseWriterTuple(change = "") {
  // The filenames below are fixed test fixtures.
  const read = (name: string) =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    JSON.parse(readFileSync(new URL(`./run-json-1.2/${name}`, import.meta.url), "utf8"))
  const run = read("run.json")
  let findings = read("vulnerabilities.json")
  const doc = read("http_exchanges.json")
  const owner = findings[0].id
  const body = doc.exchanges[0]
  switch (change) {
    case "receipt false":
      run.receipt_persisted = false
      break
    case "receipt absent":
      delete run.receipt_persisted
      break
    case "receipt string":
      run.receipt_persisted = "true"
      break
    case "unbounded pending overlap":
      findings[0].pending_http_exchange_ids = [
        "17",
        ...Array.from({ length: 10 }, (_, i) => String(100 + i)),
      ]
      break
    case "private target metadata":
      doc.binding.targets = [
        { type: "url", details: { raw_exchange: "unowned body in opaque metadata" } },
      ]
      break
    case "foreign body":
      body.request.host = "foreign.example.test"
      break
    case "orphan body":
      doc.exchanges.push({ ...body, proxy_request_id: "22" })
      break
    case "duplicate body":
      doc.exchanges.push(body)
      break
    case "absent owners":
      delete doc.binding.findings
      delete doc.binding.finding_revisions
      break
    case "stale owner":
      doc.binding.finding_revisions[owner]++
      break
    case "foreign owner":
      doc.binding.findings.foreign = ["17"]
      doc.binding.finding_revisions.foreign = 0
      break
    case "downgraded empty":
      run.schema_version = "1.1"
      findings = []
      break
    case "downgraded malformed":
      run.schema_version = "1.1"
      findings = {}
      break
    case "missing selected pending":
      doc.binding.findings[owner] = ["17"]
      break
    case "missing claiming owner":
      findings.push({ ...findings[0], id: "unbound-finding", http_exchange_ids: [] })
      break
    case "overlap only":
      findings[0].pending_http_exchange_ids.push("17")
      break
    case "shared overlap":
      findings[0].pending_http_exchange_ids.push("17")
      findings.push({ ...findings[0], id: "shared-finding", pending_http_exchange_ids: [] })
      doc.binding.findings["shared-finding"] = ["17"]
      doc.binding.finding_revisions["shared-finding"] = 0
      break
    case "overlap":
      findings[0].pending_http_exchange_ids.push("17")
      findings[0].http_exchange_ids.push("19")
      doc.binding.findings[owner].push("19")
      doc.exchanges.push({
        ...body,
        proxy_request_id: "19",
        request: { ...body.request, body_sample: "owned-19" },
      })
      body.request.body_sample = "pending-only-17"
      break
  }
  run.evidence_export.exchanges = doc.exchanges.length
  const raw = JSON.stringify(findings)
  const exportRaw = JSON.stringify(doc)
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
  return parseEngineOutput(
    raw,
    JSON.stringify(run),
    { httpExchangesRaw: exportRaw },
    { expectedRunName: "task5-writer-fixture" }
  )
}
