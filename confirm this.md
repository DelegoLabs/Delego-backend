Hi 👋 I started investigating issue #561, but the required implementation does not appear to exist in the current `Delego-backend` main branch.

Specifically:

* `apps/backend/db-vacuum/src/worker.ts` is missing.
* `audit_log_entries` does not appear in the schema or migration history.
* The only related table I found is `audit_log`, whose existing trigger rejects DELETE operations.
* The migration runner wraps SQL migrations in transactions and explicitly prohibits `CREATE INDEX CONCURRENTLY`.

I have not modified any files because implementing the requested changes against the existing schema could violate current behavior.

Could you confirm whether this issue targets another branch or commit, or whether introducing the missing table and vacuum worker is part of the intended scope?

Thanks!
