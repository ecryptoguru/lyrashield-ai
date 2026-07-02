# AG Kit Architecture

> Comprehensive AI Agent Capability Expansion Toolkit — 2026.5.13

---

## 📋 Overview

AG Kit is a modular system consisting of:

- **27 Specialist Agents** - Role-based AI personas (1 major upgrade in 2026.5.13)
- **69 Skills** - Domain-specific knowledge modules with conditional loading
- **17 Workflows** - Slash command procedures

---

## 🏗️ Directory Structure

```plaintext
.devin/
├── ARCHITECTURE.md          # This file
├── agents/                  # 27 Specialist Agents
├── skills/                  # 69 Skills (with conditional loading)
├── workflows/               # 17 Slash Commands
├── rules/                   # Global Rules
├── memory/                  # Persistent Memory (2026.5.13)
└── scripts/                 # Master Validation Scripts
```

---

## 🤖 Agents (27)

Specialist AI personas for different domains.

| Agent                               | Focus                      | Skills Used                                                                                                                    |
| ----------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `orchestrator`                      | Multi-agent coordination   | parallel-agents, coordinator-mode, memory-system, context-compression, verify-changes                                          |
| `project-planner`                   | Discovery, task planning   | brainstorming, plan-writing, architecture                                                                                      |
| `frontend-specialist`               | Web UI/UX                  | frontend-design, nextjs-react-expert, tailwind-patterns, composition-patterns, web-design-guidelines                           |
| `backend-specialist`                | API, business logic        | api-patterns, nodejs-best-practices, database-design, postgres-best-practices                                                  |
| `database-architect`                | Schema, SQL                | database-design, postgres-best-practices, prisma-expert                                                                        |
| `mobile-developer`                  | iOS, Android, RN           | mobile-design, react-native-skills                                                                                             |
| `game-developer`                    | Game logic, mechanics      | game-development, 2d-games, 3d-games, pc-games, web-games, mobile-games, vr-ar, game-design, multiplayer, game-art, game-audio |
| `devops-engineer`                   | CI/CD, Docker              | deployment-procedures, docker-expert                                                                                           |
| `security-auditor`                  | Security compliance        | vulnerability-scanner, red-team-tactics                                                                                        |
| `penetration-tester`                | Offensive security         | red-team-tactics                                                                                                               |
| `test-engineer`                     | Testing strategies         | testing-patterns, tdd-workflow, webapp-testing                                                                                 |
| `debugger`                          | Root cause analysis        | systematic-debugging                                                                                                           |
| `performance-optimizer`             | Speed, Web Vitals          | performance-profiling                                                                                                          |
| `seo-specialist`                    | Ranking, visibility        | seo-fundamentals, geo-fundamentals                                                                                             |
| `documentation-writer`              | Manuals, docs              | documentation-templates                                                                                                        |
| `product-manager`                   | Requirements, user stories, backlog, MVP | plan-writing, brainstorming                                                                                                    |
| `qa-automation-engineer`            | E2E testing, CI pipelines  | webapp-testing, testing-patterns                                                                                               |
| `code-archaeologist`                | Legacy code, refactoring   | clean-code, refactoring-patterns, code-review-checklist                                                                        |
| `explorer-agent`                    | Codebase analysis          | -                                                                                                                              |
| `ai-engineer`                       | LLM systems, RAG, evals    | llm-patterns, testing-patterns, python-patterns                                                                                |
| `autonomous-optimization-architect` | LLM cost routing           | llm-patterns, typescript-expert, python-patterns                                                                               |
| `compliance-auditor`                | SOC 2, GDPR, ISO 27001     | vulnerability-scanner, documentation-templates                                                                                 |
| `data-engineer`                     | ETL/ELT, streaming         | data-pipeline-patterns, database-design                                                                                        |
| `database-optimizer`                | Query perf, N+1, indexing  | database-design, postgres-best-practices, data-pipeline-patterns                                                               |
| `marketing-strategist`              | Growth and social strategy | growth-marketing, social-media-patterns, seo-fundamentals                                                                      |
| `sre-engineer`                      | SLOs, observability, toil  | deployment-procedures, server-management, systematic-debugging                                                                 |

---

## 🧩 Skills (69)

Modular knowledge domains that agents can load on-demand based on task context. Each skill has `when_to_use` and `effort` frontmatter fields for conditional/intelligent loading.

**Effort Legend:**

- **High** — 150+ lines. Deep expertise with actionable protocols, checklists, and anti-patterns.
- **Medium** — 80-149 lines. Solid guidance with clear principles and decision frameworks.
- **Low** — Under 80 lines. Compact reference or stub; suitable for quick lookup but may need expansion for complex tasks.

### Frontend & UI

| Skill                   | Description                                                            | Effort |
| ----------------------- | ---------------------------------------------------------------------- | ------ |
| `nextjs-react-expert`   | React & Next.js performance optimization (Vercel - 98 rules)           | High   |
| `web-design-guidelines` | Web UI audit - 100+ rules for accessibility, UX, performance (Vercel)  | Low    |
| `tailwind-patterns`     | Tailwind CSS v4 utilities                                              | High   |
| `frontend-design`       | UI/UX patterns, design systems                                         | High   |
| `ui-ux-pro-max`         | 1 file — design system index (expandable)                              | Medium |
| `composition-patterns`  | React component composition, compound components, React 19 ref changes | Medium |

### Backend & API

| Skill                   | Description                    | Effort |
| ----------------------- | ------------------------------ | ------ |
| `api-patterns`          | REST, GraphQL, tRPC            | Medium |
| `nestjs-expert`         | NestJS modules, DI, decorators | Medium |
| `nodejs-best-practices` | Node.js async, modules         | High   |
| `python-patterns`       | Python standards, FastAPI      | High   |

### Database

| Skill                     | Description                        | Effort |
| ------------------------- | ---------------------------------- | ------ |
| `database-design`         | Schema design, general principles  | Low    |
| `postgres-best-practices` | PostgreSQL query optimization, RLS | High   |
| `prisma-expert`           | Prisma ORM, migrations             | Medium |
| `data-pipeline-patterns`  | ETL/ELT, streaming, quality        | High   |

### TypeScript/JavaScript

| Skill               | Description                         | Effort |
| ------------------- | ----------------------------------- | ------ |
| `typescript-expert` | Type-level programming, performance | Medium |

### Cloud & Infrastructure

| Skill                   | Description               | Effort |
| ----------------------- | ------------------------- | ------ |
| `docker-expert`         | Containerization, Compose | Medium |
| `deployment-procedures` | CI/CD, deploy workflows   | High   |
| `server-management`     | Infrastructure management | High   |

### Testing & Quality

| Skill                   | Description              | Effort |
| ----------------------- | ------------------------ | ------ |
| `testing-patterns`      | Jest, Vitest, strategies | High   |
| `webapp-testing`        | E2E, Playwright          | High   |
| `tdd-workflow`          | Test-driven development  | High   |
| `code-review-checklist` | Code review standards    | Medium |
| `lint-and-validate`     | Linting, validation      | Low    |

### Security

| Skill                   | Description              | Effort |
| ----------------------- | ------------------------ | ------ |
| `vulnerability-scanner` | Security auditing, OWASP | High   |
| `red-team-tactics`      | Offensive security       | High   |

### Architecture & Planning

| Skill           | Description                | Effort |
| --------------- | -------------------------- | ------ |
| `app-builder`   | Full-stack app scaffolding | Low    |
| `architecture`  | System design patterns     | Low    |
| `plan-writing`  | Task planning, breakdown   | High   |
| `brainstorming` | Socratic questioning       | High   |

### Mobile

| Skill                 | Description                        | Effort |
| --------------------- | ---------------------------------- | ------ |
| `mobile-design`       | Mobile UI/UX patterns              | High   |
| `react-native-skills` | React Native & Expo best practices | Medium |

### Framework Migrations

| Skill          | Description                                      | Effort |
| -------------- | ------------------------------------------------ | ------ |
| `next-upgrade` | Next.js major version migration guide & codemods | Medium |

### Game Development

| Skill              | Description                     | Effort |
| ------------------ | ------------------------------- | ------ |
| `game-development` | Game development orchestrator   | High   |
| `2d-games`         | Sprites, tilemaps, physics      | Medium |
| `3d-games`         | Meshes, shaders, rendering      | Medium |
| `pc-games`         | Engine selection, optimization  | Medium |
| `web-games`        | Browser frameworks, WebGL       | High   |
| `mobile-games`     | Touch input, app stores         | Medium |
| `vr-ar`            | Comfort, immersion, interaction | Medium |
| `game-design`      | GDD, balancing, psychology      | Medium |
| `multiplayer`      | Networking, synchronization     | Medium |
| `game-art`         | Visual style, asset pipeline    | High   |
| `game-audio`       | Sound design, adaptive audio    | High   |

### SEO & Growth

| Skill              | Description                   | Effort |
| ------------------ | ----------------------------- | ------ |
| `seo-fundamentals`   | SEO, E-E-A-T, Core Web Vitals | Medium |
| `geo-fundamentals`   | GenAI optimization            | High   |
| `growth-marketing`   | Growth experiments, CAC/LTV   | Medium |
| `social-media-patterns` | Cross-platform strategy     | Medium |

### Shell/CLI

| Skill                | Description               | Effort |
| -------------------- | ------------------------- | ------ |
| `bash-linux`         | Linux commands, scripting | High   |
| `powershell-windows` | Windows PowerShell        | High   |

### Orchestration & Memory (2026.5.13)

| Skill                 | Description                                                 | Effort |
| --------------------- | ----------------------------------------------------------- | ------ |
| `coordinator-mode`    | Multi-agent orchestration with parallel workers & synthesis | High   |
| `memory-system`       | Persistent cross-session memory with MEMORY.md index        | High   |
| `context-compression` | Auto-compress context in long sessions                      | High   |
| `verify-changes`      | Prove code works by running it, not just inspecting         | Medium |
| `batch-operations`    | Multi-file pattern-based modifications                      | High   |
| `simplify-code`       | Reduce over-engineered complexity                           | Medium |
| `skillify`            | Auto-create skills from repetitive workflows                | High   |
| `code-review-graph`   | Token-efficient code review via Tree-sitter AST + MCP       | High   |
| `intelligent-routing` | Automatic agent selection and task routing                  | High   |

### Other

| Skill                     | Description               | Effort |
| ------------------------- | ------------------------- | ------ |
| `clean-code`              | Coding standards (Global) | High   |
| `behavioral-modes`        | Agent personas            | High   |
| `parallel-agents`         | Multi-agent patterns      | High   |
| `mcp-builder`             | Model Context Protocol    | High   |
| `documentation-templates` | Doc formats               | High   |
| `i18n-localization`       | Internationalization      | High   |
| `performance-profiling`   | Web Vitals, optimization  | Medium |
| `systematic-debugging`    | Troubleshooting           | Medium |
| `refactoring-patterns`    | Legacy modernization      | Medium |
| `llm-patterns`            | LLM systems, RAG, evals   | High   |
| `rust-pro`                | Rust systems programming  | High   |

---

## 🔄 Workflows (16)

Slash command procedures. Invoke with `/command`.

| Command          | Description                               |
| ---------------- | ----------------------------------------- |
| `/brainstorm`    | Socratic discovery                        |
| `/create`        | Create new features                       |
| `/debug`         | Debug issues                              |
| `/deploy`        | Deploy application                        |
| `/enhance`       | Improve existing code                     |
| `/orchestrate`   | Multi-agent coordination                  |
| `/plan`          | Task breakdown                            |
| `/preview`       | Preview changes                           |
| `/remember`      | **NEW** Save to persistent memory         |
| `/status`        | Check project status                      |
| `/test`          | Run tests                                 |
| `/ui-ux-pro-max` | Design with 50 styles                     |
| `/verify`        | **NEW** Prove code works by running it    |
| `/audit-ai`      | Audit AI and LLM systems                  |
| `/growth`        | Growth strategy and channel planning      |
| `/review`        | Multi-domain code review                  |

---

## 🎯 Skill Loading Protocol (2026.5.13 — Conditional)

```plaintext
User Request → Check `when_to_use` frontmatter → Match? → Load full SKILL.md
                                                    ↓ No match
                                                 Skip (save tokens)
```

### Skill Structure

```plaintext
skill-name/
├── SKILL.md           # (Required) Metadata, when_to_use & instructions
├── scripts/           # (Optional) Python/Bash scripts
├── references/        # (Optional) Templates, docs
└── assets/            # (Optional) Images, logos
```

### Required Frontmatter Fields

```yaml
---
name: skill-name
description: What this skill does
when_to_use: "When to activate. NOT for X." # 2026.5.13
allowed-tools: Read, Grep, Glob
---
```

### Enhanced Skills (with scripts/references)

| Skill           | Files | Coverage                         |
| --------------- | ----- | -------------------------------- |
| `ui-ux-pro-max` | 3     | Design system index + data + scripts |
| `app-builder`   | 20    | Full-stack scaffolding           |

---

## 🛠️ Scripts (2)

Master validation scripts that orchestrate skill-level scripts.

### Master Scripts

| Script          | Purpose                                 | When to Use              |
| --------------- | --------------------------------------- | ------------------------ |
| `checklist.py`  | Priority-based validation (Core checks) | Development, pre-commit  |
| `verify_all.py` | Comprehensive verification (All checks) | Pre-deployment, releases |

### Usage

```bash
# Quick validation during development
python .devin/scripts/checklist.py .

# Full verification before deployment
python .devin/scripts/verify_all.py . --url http://localhost:3000
```

### What They Check

**checklist.py** (Core checks):

- Security (vulnerabilities, secrets)
- Code Quality (lint, types)
- Schema Validation
- Test Suite
- UX Audit
- SEO Check

**verify_all.py** (Full suite):

- Everything in checklist.py PLUS:
- Lighthouse (Core Web Vitals)
- Playwright E2E
- Bundle Analysis
- Mobile Audit
- i18n Check

For details, see [scripts/README.md](scripts/README.md)

---

## 📊 Statistics

| Metric               | Value                             |
| -------------------- | --------------------------------- |
| **Total Agents**     | 26                                |
| **Total Skills**     | 69                                |
| **Total Workflows**  | 16                                |
| **Total Scripts**    | 2 (master) + skill-level          |
| **Coverage**         | ~95% web/mobile + orchestration   |
| **Token Efficiency** | 13-33% better than v2 (2026.5.13) |

---

## 🔗 Quick Reference

| Need        | Agent                               | Skills                                          |
| ----------- | ----------------------------------- | ----------------------------------------------- |
| Web App     | `frontend-specialist`               | nextjs-react-expert, frontend-design            |
| API         | `backend-specialist`                | api-patterns, nodejs-best-practices             |
| Mobile      | `mobile-developer`                  | mobile-design                                   |
| Database    | `database-architect`                | database-design, prisma-expert                  |
| Security    | `security-auditor`                  | vulnerability-scanner                           |
| Testing     | `test-engineer`                     | testing-patterns, webapp-testing                |
| Debug       | `debugger`                          | systematic-debugging                            |
| Plan        | `project-planner`                   | brainstorming, plan-writing                     |
| AI/LLM      | `ai-engineer`                       | llm-patterns, testing-patterns, python-patterns |
| Data        | `data-engineer`                     | data-pipeline-patterns, database-design         |
| Growth      | `marketing-strategist`              | growth-marketing, social-media-patterns         |
| Reliability | `sre-engineer`                      | deployment-procedures, server-management        |
| DB Perf     | `database-optimizer`                | database-design, data-pipeline-patterns         |
| LLM Cost    | `autonomous-optimization-architect` | llm-patterns, typescript-expert                 |
| Compliance  | `compliance-auditor`                | vulnerability-scanner, documentation-templates  |
