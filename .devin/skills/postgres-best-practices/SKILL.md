---
name: postgres-best-practices
description: Postgres optimization rules organized by impact. Covers query performance, connection management, RLS, schema design, indexing, and concurrency. Maintained by Supabase principles, applies to any Postgres setup.
when_to_use: "When writing SQL queries, designing schemas, implementing indexes, configuring connection pooling, or reviewing database performance issues. NOT for ORM-specific patterns (see prisma-expert)."
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
effort: high
---

# Postgres Best Practices

> Optimization rules organized by impact — from critical query fixes to advanced features.

---

## 1. Query Performance (CRITICAL)

### Always Use EXPLAIN ANALYZE First

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT * FROM orders WHERE user_id = 'abc' AND created_at > '2024-01-01'
```

**What to look for:**
- `Seq Scan` on large tables → Missing index
- `Nested Loop` with high row counts → Consider hash join
- `Buffers: shared read=` high → Increase `shared_buffers` or add index

### Avoid SELECT * in Production

```sql
-- Bad
SELECT * FROM users WHERE id = 1

-- Good
SELECT id, email, name FROM users WHERE id = 1
```

### Use Proper Index Types

| Scenario | Index Type |
|----------|-----------|
| Equality lookups (`=`) | B-tree |
| Range queries (`>`, `<`, `BETWEEN`) | B-tree |
| Full-text search | GIN |
| JSONB containment (`@>`) | GIN |
| Array operations | GIN |
| Geographic data | GiST |
| Very large tables, time-series | BRIN |

---

## 2. Connection Management (CRITICAL)

### Use a Connection Pooler

Direct connections exhaust Postgres quickly. Always use a pooler:

| Setup | Recommendation |
|-------|-----------------|
| Supabase | Use Supabase pooler (PgBouncer mode) |
| Self-hosted | PgBouncer or PgPool |
| Serverless | External pooler (Neon, Supabase) |

### Connection Math

```
Max connections = (CPU cores × 2) + effective_io_concurrency
```

**Rule:** Never connect directly from serverless functions without pooling.

---

## 3. Schema Design (HIGH)

### Use Appropriate Column Types

| Data | Best Type |
|------|-----------|
| Money / Currency | `numeric(19,4)` — NEVER `float` |
| Timestamps | `timestamptz` — not `timestamp` |
| JSON data with search | `jsonb` — not `json` |
| UUIDs | `uuid` with `gen_random_uuid()` |
| Enums | `ENUM` type or `text` with CHECK constraint |
| Large text | `text` — no length limit needed |

### Add Indexes Early

```sql
-- Index foreign keys automatically
CREATE INDEX idx_orders_user_id ON orders(user_id);

-- Composite index for multi-column filters
CREATE INDEX idx_orders_status_created ON orders(status, created_at DESC);

-- Partial index for hot queries
CREATE INDEX idx_active_users ON users(last_login) WHERE active = true;
```

---

## 4. Row-Level Security (CRITICAL)

### RLS Policy Performance

Bad policies cause full table scans. Always include the user check in the index:

```sql
-- Bad: Forces sequential scan
CREATE POLICY "users_own_data" ON orders
  FOR ALL USING (auth.uid() = user_id);

-- Good: With supporting index
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE POLICY "users_own_data" ON orders
  FOR ALL USING (user_id = auth.uid());
```

### Enable RLS on Every Table

```sql
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
-- Without policies, this blocks ALL access — add policies immediately
```

---

## 5. Concurrency & Locking (MEDIUM-HIGH)

### Prefer Advisory Locks for App-Level Coordination

```sql
-- Acquire lock
SELECT pg_advisory_lock(42);

-- Do work
INSERT INTO jobs (payload) VALUES ('...');

-- Release lock
SELECT pg_advisory_unlock(42);
```

### Use SKIP LOCKED for Queue Patterns

```sql
SELECT * FROM jobs
WHERE status = 'pending'
ORDER BY created_at
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

---

## 6. Data Access Patterns (MEDIUM)

### Batch Inserts

```sql
-- Bad: N round trips
INSERT INTO logs (level, message) VALUES ('info', 'a');
INSERT INTO logs (level, message) VALUES ('info', 'b');

-- Good: Single round trip
INSERT INTO logs (level, message)
VALUES ('info', 'a'), ('info', 'b'), ('warn', 'c');
```

### Use CTEs for Complex Queries

```sql
WITH recent_orders AS (
  SELECT user_id, COUNT(*) as count
  FROM orders
  WHERE created_at > NOW() - INTERVAL '30 days'
  GROUP BY user_id
)
SELECT u.name, COALESCE(r.count, 0) as order_count
FROM users u
LEFT JOIN recent_orders r ON u.id = r.user_id;
```

---

## 7. Monitoring & Diagnostics (LOW-MEDIUM)

### Enable Slow Query Logging

```sql
-- In postgresql.conf
log_min_duration_statement = 1000  -- Log queries > 1s
```

### Use pg_stat_statements

```sql
SELECT query, calls, total_exec_time, mean_exec_time
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

---

## 8. Advanced Features (LOW)

### Partitioning for Large Tables

```sql
CREATE TABLE events (
  id bigint,
  created_at timestamptz,
  data jsonb
) PARTITION BY RANGE (created_at);

CREATE TABLE events_2024_q1 PARTITION OF events
  FOR VALUES FROM ('2024-01-01') TO ('2024-04-01');
```

### Full-Text Search

```sql
CREATE INDEX idx_articles_search ON articles
  USING GIN (to_tsvector('english', title || ' ' || content));
```

---

## Performance Review Checklist

- [ ] All queries use EXPLAIN ANALYZE before optimization
- [ ] No `SELECT *` in production queries
- [ ] Foreign keys have indexes
- [ ] RLS policies have supporting indexes
- [ ] Connection pooler is configured
- [ ] `timestamptz` used for all timestamps
- [ ] `numeric` used for currency, not `float`
- [ ] Slow query logging enabled
- [ ] `pg_stat_statements` enabled for diagnostics
