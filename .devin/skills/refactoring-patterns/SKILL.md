---
name: refactoring-patterns
description: Patterns and strategies for refactoring legacy code, modernizing codebases, and improving code structure without breaking functionality. Use when refactoring, modernizing, or restructuring existing code.
when_to_use: "When refactoring legacy code, modernizing old codebases, restructuring poor architecture, or improving code quality through systematic changes."
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
effort: medium
---

# Refactoring Patterns

> Principles for improving code safely, without introducing regressions.
> **Refactoring is not rewriting. It is a series of verified, reversible changes.**

---

## 1. Core Principles

- Never refactor without tests or a safety net
- Each refactor should be small, focused, and independently reversible
- Preserve behavior first; optimize or redesign only after clarity
- Read before writing: understand the existing system before changing it
- Commit after each verified step; keep a clean rollback path

---

## 2. Preparation

### Before touching code
- Identify the goals: readability, performance, testability, or dependency reduction
- Map the blast radius: who depends on this code?
- Write characterization tests that capture current behavior
- Set up automated test feedback (watch mode, CI check)

### Safety nets
- Unit tests for isolated logic
- Integration tests for boundary behavior
- Feature flags for risky structural changes
- Version control: commit before and after each step

---

## 3. Common Refactorings

### Extract and rename
- Extract long methods into named, single-purpose functions
- Rename variables and functions to reflect actual intent
- Prefer explicit names over comments explaining the code

### Reduce coupling
- Break circular dependencies by introducing abstractions
- Replace concrete class references with interfaces or types
- Move shared logic into dedicated modules or utilities

### Simplify control flow
- Replace nested conditionals with early returns or guard clauses
- Flatten deep call chains where possible
- Use state machines or strategy patterns for complex branching

---

## 4. Modernization Strategy

### Strangler Fig pattern
- Build new functionality alongside the old system
- Gradually route traffic to the new implementation
- Remove old code only after the new path is proven

### Incremental adoption
- Migrate one module or feature at a time
- Maintain backward compatibility at boundaries
- Use adapters to bridge old and new interfaces

---

## 5. Testing During Refactor

- Characterization tests: capture current behavior before changing
- Approval tests: compare outputs for large-scale structural changes
- Snapshot tests: guard against unintended UI or API changes
- Red-green: ensure each change passes existing tests

---

## 6. Decision Checklist

Before refactoring:
- [ ] Is the current behavior tested or documented?
- [ ] Is the goal clear: readability, performance, testability?
- [ ] Can this be done in small, independent steps?
- [ ] Is there a rollback plan?

During refactoring:
- [ ] Did tests pass before the change?
- [ ] Do tests still pass after the change?
- [ ] Is the diff reviewable and reversible?

---

## 7. Anti-Patterns

- Large, unreviewable refactors without intermediate commits
- Refactoring without any safety net
- Mixing refactoring with feature work in the same commit
- Deleting code before proving the replacement works
- Optimizing without measuring performance
- Rewriting instead of understanding first

---

> **Remember:** The best refactors are invisible. They improve the code without changing behavior, risk, or delivery speed.
