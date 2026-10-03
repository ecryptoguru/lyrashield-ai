---
description: Start a LyraShield scan after the user explicitly requests one.
---

Follow the `scan-project` skill. Resolve the authorized workspace and target; ask if either is missing or ambiguous. Use Quick for ordinary pre-PR checks, Standard for general reviews and Deep only when explicitly requested and allowed. Keep one idempotency key for the intended action and reuse it only for an identical retry. Preserve the returned scan or operation ID, poll with bounded backoff and report the terminal evidence state.
