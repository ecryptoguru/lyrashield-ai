---
name: prisma-expert
description: Prisma ORM expert covering schema design, migrations, queries, performance optimization, and advanced patterns. Use when working with Prisma, database schemas, or migration strategies.
when_to_use: "When working with Prisma ORM, designing schemas, writing migrations, optimizing queries, or handling database operations in TypeScript/Node.js."
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
effort: medium
---

# Prisma Expert

> Principles for schema design, safe migrations, and performant queries with Prisma ORM.
> **The schema is the contract. Treat it as carefully as any API surface.**

---

## 1. Core Principles

- Schema changes are breaking changes unless explicitly backward compatible
- Migrations must be reversible and reviewable in production
- Queries should be explicit about what they fetch; implicit includes are dangerous
- Connection pooling and transaction boundaries are part of the query design
- Raw queries are acceptable when type-safe abstractions become inefficient

---

## 2. Schema Design

### Modeling

- Prefer explicit relations over implicit conventions
- Use enums for closed sets, not strings
- Add indexes early for foreign keys and frequently filtered fields
- Keep business logic out of default values unless truly universal

### Naming

- Table names: singular PascalCase models (Prisma convention)
- Field names: camelCase
- Use consistent vocabulary across the schema

---

## 3. Migration Safety

- Never modify a migration file after it has been applied to a shared environment
- Use `prisma migrate dev` locally, `prisma migrate deploy` in CI/production
- For data migrations, write separate scripts; do not rely on Prisma's generated SQL
- Back up before destructive migrations
- Test migrations against a production-like dataset

---

## 4. Query Patterns

### Prefer

- `findUnique` with indexed fields
- Explicit `select` or `include` to avoid over-fetching
- `transaction` for multi-step writes
- `upsert` for idempotent inserts

### Avoid

- `findMany` without pagination on large tables
- Deeply nested `include` chains that explode result size
- N+1 patterns in loops (use `include` or batch with `findMany`)
- Relying on default includes that may change

---

## 5. Performance

- Index foreign keys and common query predicates
- Use `count` with `select` when only counting, not fetching rows
- Offload heavy aggregation to raw SQL or the database when Prisma's abstraction is too slow
- Monitor query logs in development to catch slow queries early

---

## 6. Raw Query Boundaries

- Use `$queryRaw` for complex aggregation, CTEs, or window functions
- Validate all user input before interpolating into raw SQL
- Prefer tagged template literals with parameterized queries
- Keep raw query usage isolated behind repository or service boundaries

---

## 7. Decision Checklist

Before schema changes:

- [ ] Is this migration backward compatible?
- [ ] Are indexes added for new foreign keys or query fields?
- [ ] Is a data migration needed?
- [ ] Has the migration been tested against realistic data?

Before complex queries:

- [ ] Is the select/include explicit and bounded?
- [ ] Could this create an N+1?
- [ ] Is pagination applied?
- [ ] Should this be a raw query instead?

---

## 8. Anti-Patterns

- Treating schema changes as trivial after launch
- Using Prisma for heavy analytics without raw SQL fallback
- Deep nesting includes without result size limits
- Ignoring connection pool exhaustion under load
- Mixing schema defaults with business rules that change

---

> **Remember:** Prisma is a contract layer. A disciplined schema and explicit queries make it powerful; magic and defaults make it brittle.
