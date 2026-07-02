---
description: Run a multi-domain review of code or architecture. Use for broad implementation reviews that may need backend, frontend, security, AI, data, Web3, or growth specialists.
---

# /review - Multi-Domain Review

$ARGUMENTS

---

## Purpose

This command performs a broad review across the relevant domains and routes to the correct specialists before conclusions are made.

---

## Primary Routing

- Primary agents: `explorer-agent`, `orchestrator`
- Supporting agents: selected from the task domain
- Typical specialist pool: `backend-specialist`, `frontend-specialist`, `security-auditor`, `ai-engineer`, `data-engineer`, `marketing-strategist`, `test-engineer`

---

## When to Use

Use this workflow for:

- broad feature or architecture reviews
- multi-file implementation assessment
- pre-merge or pre-release review passes
- identifying which specialist should handle each concern
- cross-domain quality and risk reviews

---

## Workflow

1. Start with discovery
   - use `explorer-agent` or direct codebase reading to map the affected surface

2. Classify domains touched
   - frontend
   - backend
   - database
   - security
   - AI / LLM
   - data pipelines
   - Web3
   - growth / SEO
   - testing / deployment

3. Route to the right specialists
   - use the narrowest expert that matches the real risk or implementation area

4. Review findings by domain
   - correctness
   - maintainability
   - security
   - performance
   - missing tests
   - architectural drift

5. Synthesize a final report
   - strengths
   - issues
   - priority fixes
   - ownership suggestions

---

## Output Format

```markdown
## Review Report

### Scope
- [files or systems reviewed]

### Domain Findings
- [frontend/backend/security/etc]

### Priority Fixes
- [ordered action items]

### Suggested Owners
- [agent/domain mapping]
```

---

## Rules

- Do not let one specialist overreach into another domain without reason
- Ask clarifying questions first if scope is too broad to review responsibly
- Prefer evidence from code and behavior over assumptions
- Escalate to `orchestrator` when the review spans multiple specialist domains
