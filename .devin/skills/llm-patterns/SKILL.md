---
name: llm-patterns
description: LLM systems and AI integration principles. RAG architecture, prompt design, evaluation, model routing, and cost-safe production patterns.
when_to_use: "When designing LLM systems, prompt pipelines, RAG architectures, model routing, evaluation frameworks, or structured output flows."
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
effort: medium
---

# LLM Patterns

> Principles for building production LLM features without fragile prompts, runaway cost, or unsafe outputs.
> **Learn to THINK in systems, not just prompts.**

---

## 1. Core Principles

- Start from the product task, not the model vendor
- Prefer deterministic workflows before open-ended generation
- Treat prompts, retrieval, and evaluation as one system
- Set hard limits for cost, latency, retries, and output size
- Assume every model can hallucinate, over-comply, or fail silently

---

## 2. Decision Areas

### Use an LLM when:

- Unstructured language understanding is required
- Summarization, extraction, ranking, or generation has ambiguity
- Rules-only systems create unacceptable maintenance burden

### Do NOT default to an LLM when:

- A lookup table, classifier, or deterministic parser is enough
- Accuracy must be exact and auditable without review
- Latency or cost budget is too tight for remote inference

---

## 3. RAG Design

### Retrieval Checklist

- [ ] Chunking matches the question granularity
- [ ] Metadata is attached for filtering and attribution
- [ ] Retrieved context is ranked before prompt injection into the model
- [ ] Source documents are cited or traceable in output
- [ ] Fallback exists when retrieval confidence is weak

### RAG Anti-Patterns

- Dumping full documents into context
- Mixing retrieval and generation quality problems
- No freshness or deduplication strategy
- No citation requirement for factual answers

---

## 4. Prompt Design Principles

- Give the model a single job per step
- Separate instructions, context, and output schema clearly
- Use structured outputs for downstream automation
- Constrain tone and format only after task clarity is achieved
- Prefer reusable prompt templates over ad hoc prompt sprawl

---

## 5. Evaluation and Guardrails

### Evaluate on:

- Accuracy
- Citation faithfulness
- Refusal behavior
- Latency
- Cost per run
- Output consistency under repeated runs

### Guardrails

- Enforce max token and cost ceilings
- Add circuit breakers for 402/429 storms or abnormal traffic spikes
- Reject unsafe tool calls or code-like payloads when not expected
- Quarantine low-confidence outputs for human review

---

## 6. Multi-Model Routing

Choose routing strategy based on:

- best accuracy for task type
- acceptable latency percentile
- output format reliability
- marginal cost per successful task
- fallback behavior when primary model fails

Do not route purely on benchmark reputation.

---

## 7. Privacy and Safety

- Minimize PII in prompts and logs
- Prefer redaction before external API calls
- Keep audit trails for transformed records
- Add bias and fairness checks where user outcomes are affected
- Never rely on open-ended retries to recover quality

---

## 8. Decision Checklist

Before implementing:

- [ ] Is an LLM actually necessary?
- [ ] Is retrieval needed or would direct prompting suffice?
- [ ] Are cost and latency budgets explicit?
- [ ] Is structured output defined?
- [ ] Is there an evaluation method beyond vibes?
- [ ] Are safety, privacy, and fallback behaviors defined?

---

> **Remember:** The best LLM system is usually a constrained workflow with measurable quality, not a clever single prompt.
