---
name: data-pipeline-patterns
description: Data pipeline engineering principles. ETL/ELT design, idempotency, observability, schema drift handling, streaming, and data quality.
when_to_use: "When designing data pipelines, ETL/ELT workflows, stream processing, batch jobs, or data quality systems."
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
effort: medium
---

# Data Pipeline Patterns

> Principles for pipelines that are reliable, observable, and safe to rerun.
> **Pipelines fail in production unless reliability is designed up front.**

---

## 1. Core Principles

- Every pipeline should be idempotent
- Schema drift must be detected, not silently absorbed into trusted outputs
- Freshness, completeness, and correctness each need explicit checks
- Bronze/raw and trusted/business layers must have different guarantees
- Reprocessing strategy must exist before launch

---

## 2. Layering Model

### Common layer responsibilities

- Raw/Bronze: immutable ingest, append-first, full source traceability
- Clean/Silver: deduplicated, typed, standardized, joinable
- Business/Gold: consumer-facing, SLA-backed, optimized for downstream use

Do not let business consumers depend directly on raw ingest tables.

---

## 3. Reliability Rules

- Record source metadata on ingest
- Prefer append + upsert discipline over in-place mutation
- Design retry behavior to avoid duplicates
- Use checkpoints or cursor state for incremental syncs
- Make backfills explicit and auditable

---

## 4. Data Quality

Monitor at minimum:

- row counts
- null rate on key fields
- duplication rate
- freshness lag
- schema contract changes
- reconciliation against source totals where possible

If quality cannot be proven, outputs should not be trusted.

---

## 5. Streaming vs Batch

Choose streaming when:

- user-facing freshness matters
- events arrive continuously
- downstream actions depend on low-latency propagation

Choose batch when:

- data volume is periodic
- exactness and simplicity matter more than immediacy
- source systems do not support reliable event delivery

---

## 6. Financial and Market Data Considerations

- Normalize symbols, identifiers, timestamps, and currency units early
- Reconcile conflicting sources explicitly
- Preserve source-of-truth provenance for derived metrics
- Detect missing intervals, stale market snapshots, and outlier spikes
- Separate business logic from ingest mechanics

---

## 7. Operational Checklist

Before implementation:

- [ ] Source contract and ownership identified
- [ ] Full refresh vs incremental strategy chosen
- [ ] Deduplication key defined
- [ ] Freshness SLA defined
- [ ] Alerting path defined
- [ ] Backfill and replay strategy defined

---

## 8. Anti-Patterns

- Silent schema auto-acceptance in trusted layers
- Full-table rescans as the default forever
- No lineage for downstream metrics
- No alerting until dashboards look wrong
- Mixing transformation logic with delivery-specific hacks

---

> **Remember:** Good data pipelines are boring in the best way: predictable, replayable, and measurable.
