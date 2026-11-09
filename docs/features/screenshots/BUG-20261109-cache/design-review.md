# Cache freshness design review

Independent reviewer inspected the planned and implemented Redis/SQL protocol without executing tests.

- Blocking: old and new workers sharing `cfg:risk:latest` could overwrite each other's markers and reintroduce stale v1. Fixed by isolating new markers under `cfg:risk:latest:v2`; a PostgreSQL + Valkey regression first failed with the shared key and passed after the change.
- Required assumptions: Redis wall clock (including failover) and local clocks must not run backwards or at an incorrect rate; primary reads use READ COMMITTED; version allocation and commit order must be serialized; Redis is trusted. These are documented in the feature note.
- `SET NX` does not repair corrupted immutable content. Repository falls back to PostgreSQL rather than overwriting it.
- Re-review after isolation: reviewer found no further blocking issue within those assumptions. This is a read-only review, not CI or a Dev approval.
