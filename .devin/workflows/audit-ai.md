---
description: Audit AI and LLM systems. Use for RAG reviews, prompt pipeline safety, model routing, evaluation quality, and cost/latency guardrail checks.
---

# /audit-ai - AI Systems Audit

$ARGUMENTS

---

## Purpose

This command audits AI features for safety, quality, observability, and production readiness.

---

## Primary Routing

- Primary agent: `ai-engineer`
- Supporting agents when needed: `backend-specialist`, `security-auditor`, `data-engineer`, `test-engineer`
- Primary skills: `llm-patterns`, `testing-patterns`

---

## When to Use

Use this workflow for:

- RAG architecture reviews
- Prompt pipeline audits
- Structured output reliability checks
- Model routing and fallback reviews
- LLM cost and latency guardrail reviews
- Prompt injection, privacy, or unsafe automation risk checks

---

## Workflow

1. Classify the AI feature under review
   - retrieval
   - generation
   - extraction
   - ranking
   - agent/tool automation

2. Map the system boundaries
   - inputs
   - retrieval sources
   - model calls
   - validation steps
   - outputs
   - logging and monitoring

3. Audit core concerns
   - factual grounding
   - structured output reliability
   - fallback behavior
   - cost ceilings
   - latency budgets
   - privacy exposure
   - prompt injection resilience

4. Pull in specialists if needed
   - `backend-specialist` for service/runtime concerns
   - `security-auditor` for abuse and prompt/tool risks
   - `data-engineer` for retrieval/index/data quality issues
   - `test-engineer` for evaluation or regression-test gaps

5. Return findings with severity
   - blockers
   - risks
   - recommended fixes
   - missing instrumentation

---

## Output Format

```markdown
## AI Audit Report

### Scope
- [system or feature]

### Findings
- [severity] [issue]

### Guardrails
- [present/missing]

### Recommended Fixes
- [action items]
```

---

## Rules

- Do not assume prompt quality from one successful example
- Do not approve AI automation without validation boundaries
- Ask clarifying questions first if the system architecture is unclear
- Escalate to `security-auditor` when tool use or sensitive data is involved
