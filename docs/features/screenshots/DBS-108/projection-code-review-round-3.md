**APPROVE** — No demonstrable defect remains for JSON-origin inputs or correctly typed internal events.

The projection snapshots the event timestamps and doubled median before using them, validates the median against `MONEY_MAX`, constructs an allowlisted payload, and replaces validation failures with a generic error. This is a static review; no execution is claimed.