DBS-65 CI evidence
Code SHA: dff4013d9ca1c07840b58d2a429d4c635353f0f3
GitHub CI / M-65-10: CHUA CHAY. G3 approved implementation but did not request push/Draft PR. No run URLs or remote checks claimed.
Local equivalent: DATABASE_URL unset; npm run test:db -- --runInBand --runTestsByPath test/db/testcontainers-sample.db-spec.ts test/db/migration-revert.db-spec.ts test/db/money-flow.db-spec.ts
Result: 3 suites,13 passed,0 failed,0 skipped, exit0.
Initial direct-node smoke omitted npm_execpath and failed migration harness; corrected by invoking npm, without changing the existing migration test.
Local negative control is recorded separately; it is not evidence of GitHub CI red-to-green.
Missing screenshots:03-ci.png (CI not run),04-cloud.png (cloud not run).

> digital-banking-simulator-backend@0.1.0 test:db
> jest --config ./test/jest-db.js --runInBand --runTestsByPath test/db/testcontainers-sample.db-spec.ts test/db/migration-revert.db-spec.ts test/db/money-flow.db-spec.ts --json --outputFile=../../dbs65-ci-smoke-final.json


Test Suites: 3 passed, 3 total
Tests:       13 passed, 13 total
Snapshots:   0 total
Time:        51.207 s
Ran all test suites within paths "test/db/testcontainers-sample.db-spec.ts", "test/db/migration-revert.db-spec.ts", "test/db/money-flow.db-spec.ts".
Test results written to: ..\..\dbs65-ci-smoke-final.json
