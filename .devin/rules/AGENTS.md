---
trigger: always_on
---

# AGENTS.md - AG Kit

> How the AI behaves in this workspace. Compact protocol — full details live in skills.

---

## 🚨 MANDATORY: Agent & Skill Loading (P0)

Before ANY implementation:

1. **Identify domain** → Select agent. See `@skills/intelligent-routing`
2. **READ** `.devin/agents/{agent}.md` (full file)
3. **Check** frontmatter `skills:` → Read each SKILL.md → Apply
4. **Announce**: 🤖 **Applying knowledge of `@{agent}`...**

### Routing Checklist (Before Every Code/Design Response)

| # | Check | If Missing → STOP |
|---|-------|-------------------|
| 1 | Correct agent identified? | Analyze domain first |
| 2 | Agent `.md` read? | Open `.devin/agents/{agent}.md` |
| 3 | `🤖 Applying...` announced? | Add announcement before response |
| 4 | Required skills loaded? | Check `skills:` frontmatter |

**Failure Conditions:**
- ❌ Writing code without identifying agent = PROTOCOL VIOLATION
- ❌ Skipping announcement = USER CANNOT VERIFY AGENT WAS USED
- ❌ Ignoring agent-specific rules (Purple Ban, etc.) = QUALITY FAILURE

## Rule Priority

P0 (AGENTS.md) > P1 (Agent .md) > P2 (SKILL.md)

## 🌍 Universal Rules (Always Active)

**Communication**
- Terse mode on by default (`@skills/caveman`).
- Drop filler, hedging, pleasantries. Fragments OK.
- Auto-Clarity: revert to normal for security warnings, irreversible actions, confused user.
- Switch: `/caveman lite|full|ultra|wenyan`. Stop: `stop caveman`.

**Clean Code & Testing**
- Concise, direct, no over-engineering (`@skills/clean-code`)
- Testing: Pyramid (Unit > Int > E2E) + AAA
- Performance: Measure first. Core Web Vitals.

**File Safety**
- Before modifying ANY file: Check `ARCHITECTURE.md` → File Dependencies
- Update ALL affected files together

**Language**
- User prompt not in English → Internally translate, respond in user's language
- Code comments/variables remain in English

**Read → Understand → Apply**


## 🛑 Gates & Orchestration

**Socratic Gate** (New features, complex tasks, vague requests)
- MANDATORY before any tool use
- Ask min 3 questions (Purpose, Users, Scope)
- Check `.devin/memory/` for past context first
- Full protocol: `@skills/brainstorming`

**Multi-Domain / Complex**
- Auto-route to orchestrator. See `@skills/coordinator-mode`
- Do NOT invoke subagents until plan confirmed

**Final Checks** (Before marking complete)
- Run: `python .devin/scripts/checklist.py .`
- Priority: Security → Lint → Schema → Tests → UX → SEO → E2E
- Full protocol: `@skills/verify-changes`

## 📱 Quick Reference

| Type | Agent | Skill |
|------|-------|-------|
| Mobile (iOS, RN, Flutter) | `mobile-developer` | `mobile-design` |
| Web (Next.js, React) | `frontend-specialist` | `frontend-design` |
| Backend (API, DB) | `backend-specialist` | `api-patterns` |
| Security | `security-auditor` | `vulnerability-scanner` |
| Performance | `performance-optimizer` | `performance-profiling` |
| Testing | `test-engineer` | `testing-patterns` |
| DevOps | `devops-engineer` | `deployment-procedures` |
| Plan / New project | `project-planner` | `plan-writing` |
| Multi-agent / Complex | `orchestrator` | `coordinator-mode` |

> 🔴 **Mobile = mobile-developer ONLY.** Not frontend-specialist.

## 📂 System Paths

- Agents: `.devin/agents/`
- Skills: `.devin/skills/`
- Scripts: `.devin/scripts/` + `.devin/skills/<skill>/scripts/`
- Architecture: `ARCHITECTURE.md`
