---
name: nestjs-expert
description: NestJS expert covering modules, dependency injection, decorators, interceptors, guards, and enterprise patterns. Use when building or refactoring NestJS applications.
when_to_use: "When building NestJS backends, designing modules, implementing DI, writing decorators, or applying enterprise patterns in Node.js."
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
effort: medium
---

# NestJS Expert

> Principles for building maintainable, testable NestJS services with clean boundaries.
> **Modules are boundaries, not folders.**

---

## 1. Core Principles

- Modules should reflect domain boundaries, not file locations
- Controllers handle HTTP concerns only; delegate to services immediately
- Services should be stateless and side-effect transparent
- Use DI to invert dependencies, not to avoid explicit wiring
- Configuration belongs in config modules, not scattered in providers

---

## 2. Module Design

### Structure
- One module per bounded domain or feature
- Shared concerns (database, config, logging) live in core modules
- Cross-module dependencies should be explicit imports, not implicit globals
- Avoid circular dependencies; refactor shared logic into a third module

### Providers
- Providers should have single, clear responsibilities
- Use `@Injectable()` for everything that needs DI
- Export only what other modules need

---

## 3. Controller Patterns

- Validate and transform at the boundary with DTOs and pipes
- Keep controllers thin; no business logic in route handlers
- Use guards for authorization, interceptors for cross-cutting concerns
- Return consistent response shapes; do not leak internal errors

---

## 4. Service Design

- Services should not depend on HTTP context
- Prefer explicit constructor injection over property injection
- Keep transactions at the service boundary, not controller level
- Repository pattern: abstract Prisma/TypeORM calls behind interfaces

---

## 5. Cross-Cutting Concerns

### Guards
- Use for authentication and authorization
- Keep authorization checks declarative where possible

### Interceptors
- Logging, metrics, and response transformation
- Avoid business logic in interceptors

### Pipes
- Input validation and transformation
- Use class-validator DTOs for declarative validation

### Filters
- Exception handling and error response formatting
- Catch domain exceptions and map to HTTP responses

---

## 6. Testing

- Unit test services in isolation with mocked dependencies
- E2E test modules with `Test.createTestingModule`
- Test guards and pipes independently where logic is complex
- Do not test NestJS framework plumbing; test your logic

---

## 7. Decision Checklist

Before adding a module:
- [ ] Does this represent a domain boundary?
- [ ] Is the public API minimal and stable?
- [ ] Are dependencies explicit and acyclic?

Before writing a service:
- [ ] Is it stateless?
- [ ] Are external calls abstracted?
- [ ] Is the error strategy defined?

---

## 8. Anti-Patterns

- Controllers with business logic
- Modules as folder mirrors instead of domain boundaries
- Deep dependency chains hidden by DI
- Configuration scattered across decorators
- Circular dependencies ignored with `forwardRef`
- Testing NestJS wiring instead of domain logic

---

> **Remember:** NestJS is a framework for organizing code, not a substitute for design discipline.
