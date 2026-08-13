# Authorized AI safety test pack

This private beta contract defines a fixed, non-destructive catalog for prompt injection, tool-result injection, system-prompt disclosure, secret disclosure, and unexpected tool calls. It is not a public endpoint scanner or a claim of adversarial robustness.

Before a plan can run, the workspace must provide a target-scoped written authorization, a customer-owned non-production HTTPS endpoint, encrypted test credential reference, incident contact, exact approved hostname, request/duration/response limits, and a stop or rollback contact. URLs cannot contain credentials. Destructive tests, browser automation, arbitrary fuzzing, redirects, and model-selected tools are excluded.

Each catalog fixture has a deterministic predicate, request cap, and stop condition. The runner must persist only case ID, bounded status, response hash, duration, and terminal reason. Raw prompts and responses are excluded from reports, analytics, logs, and LLM context; encrypted private storage is allowed only when the approved plan explicitly selects it.
