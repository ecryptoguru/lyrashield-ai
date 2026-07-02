---
name: typescript-expert
description: Advanced TypeScript principles. Type modeling, generics, discriminated unions, runtime validation boundaries, and maintainable type-safe API design.
when_to_use: "When solving complex TypeScript typing problems, optimizing type performance, or designing type-safe APIs and architectures."
allowed-tools: Read, Write, Edit, Glob, Grep
effort: medium
---

# TypeScript Expert

> Principles for using TypeScript to reduce whole classes of bugs without turning code into type gymnastics.
> **Model meaning, not just syntax.**

---

## 1. Core Principles

- Types should express domain constraints, not just satisfy the compiler
- Prefer simple explicit models before abstract generic frameworks
- Keep runtime validation at boundaries; types alone do not validate inputs
- Use narrowing and discriminated unions for state machines and workflows
- Strong types should improve maintainability, not intimidate collaborators

---

## 2. Type Modeling

Prefer:

- discriminated unions for stateful flows
- branded or nominal patterns for high-risk identifiers
- exact object shapes for important contracts
- derived utility types only when they stay readable

Avoid:

- deep conditional types without real payoff
- broad `any` or `unknown` leaks into application logic
- magic generic abstractions that obscure data flow

---

## 3. API and Validation Boundaries

- Validate incoming data at the edge with Zod, Valibot, or equivalent
- Convert validated input into trusted internal types
- Keep external API payloads distinct from domain models where semantics differ
- Model error and success responses explicitly

---

## 4. Maintainability Rules

- Types should make refactors safer
- Prefer named types for reused business concepts
- Remove dead types aggressively
- Avoid inference dependence when exported contracts become unclear
- Favor composable modules over giant shared type files

---

## 5. Common High-Value Patterns

Use TypeScript strongly for:

- API response contracts
- command/event shapes
- reducer or workflow states
- feature flags and configuration models
- repository and service boundaries

---

## 6. Decision Checklist

Before introducing advanced typing:

- [ ] Does this type model a real domain constraint?
- [ ] Will teammates understand it quickly?
- [ ] Is runtime validation still present where needed?
- [ ] Does this reduce bugs or just look sophisticated?
- [ ] Would a simpler named type be better?

---

## 7. Anti-Patterns

- Using `any` to bypass design decisions
- Hiding broken architecture behind clever type utilities
- Treating compiler success as runtime safety
- Encoding business logic in unreadable type-level programming
- Exporting vague catch-all utility types everywhere

---

> **Remember:** Great TypeScript makes your codebase feel smaller, safer, and more obvious.
