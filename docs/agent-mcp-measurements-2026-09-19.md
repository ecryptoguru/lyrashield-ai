# MCP context and latency measurement

Checked 2026-09-19 on macOS 27.0, Node 24.17.0. Baseline is the published `@lyrashield/mcp@0.2.8` installed outside the monorepo. Candidate is a local packed `@lyrashield/mcp@0.2.9`, also installed outside the monorepo. Both used `McpServer` with the same mocked successful fetch response. This is an in-process contract microbenchmark, not a desktop-client or network latency receipt.

| Measure | Published 0.2.8 | Candidate 0.2.9 |
| --- | ---: | ---: |
| Tool count | 14 | 14 |
| Serialized tool-list bytes | 12,143 | 12,661 |
| Server construction median, 50 runs | 0.0039 ms | 0.0035 ms |
| Read call median, 100 warm runs | 0.027 ms | 0.033 ms |
| Read call p95, 100 warm runs | 0.043 ms | 0.072 ms |
| Small read result bytes | 193 | 193 |
| Oversized Unicode findings result bytes | 1,200,246 | 262,140 |
| Oversized result marked truncated | No | Yes |

The large fixture is one 150,000-emoji finding plus a continuation cursor. Candidate output remains under 262,144 UTF-8 JSON bytes and marks the evidence incomplete. Tiny timing differences are below useful host/runtime precision and show no demonstrated latency improvement. Tool-list size rises by 518 bytes to document pagination and safe retry semantics. No cache or proxy was added. Actual client startup, auth, tool discovery and remote read latency remain in the [client acceptance matrix](agent-client-acceptance-2026-09-19.md) as blocked.
