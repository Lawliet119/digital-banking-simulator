# Domain Review — DBS-172: Connection Pool Sizing & Capacity Planning

- **Reviewer:** Adversarial Self-Review (Gemini 3.8 Flash)
- **Target:** Capacity limits between TypeORM poolMax and AWS RDS max_connections
- **Verdict:** PASS

## Findings

1. **[RESOLVED] Formula accuracy:**
   - Evaluated default RDS formula: LEAST(RAM/9531392, 5000) yielding 112 for db.t4g.micro.
   - 2 API + 2 Worker tasks @ 10 poolMax + 15 buffer = 55 connections, leaving 50.9% headroom.
2. **[RESOLVED] Multi-tier scaling:**
   - db.t4g.small (225 max) and db.t4g.medium (450 max) plans verified against scaled container scenarios.
