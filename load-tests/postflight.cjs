const { readFileSync } = require("node:fs");
const { Client } = require("../backend/node_modules/pg");

async function withDb(work) {
  const ssl = process.env.DATABASE_SSL === "true";
  if (["staging", "production"].includes(process.env.NODE_ENV) && !ssl)
    throw new Error("TLS required");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
    ssl: ssl
      ? {
          rejectUnauthorized: true,
          ...(process.env.DATABASE_SSL_CA_PATH
            ? { ca: readFileSync(process.env.DATABASE_SSL_CA_PATH, "utf8") }
            : {}),
        }
      : undefined,
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}
async function snapshot(fixture) {
  return withDb(async (client) => {
    const counts = (
      await client.query(
        `SELECT (SELECT count(*)::int FROM transfers) AS transfers, (SELECT count(*)::int FROM ledger_entries) AS entries`,
      )
    ).rows[0];
    const accounts = (
      await client.query(
        `SELECT a.id, a.balance::text, u.cognito_sub AS sub, a.status,
      COALESCE((SELECT sum(l.amount) FROM ledger_entries l WHERE l.account_id=a.id AND l.direction='DEBIT'
       AND l.created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh')),0)::text AS spent
      FROM accounts a JOIN customers c ON c.id=a.customer_id JOIN users u ON u.id=c.user_id WHERE a.id=ANY($1::uuid[])`,
        [fixture.customers.map((c) => c.accountId)],
      )
    ).rows;
    for (const c of fixture.customers) {
      const a = accounts.find(
        (a) => a.id === c.accountId && a.sub === c.sub && a.status === "ACTIVE",
      );
      if (!a)
        throw new Error("DATABASE_URL does not match active fixture owners");
    }
    return { ...counts, accounts };
  });
}
function assertDuplicateCounts(delta, bursts) {
  if (
    !Number.isInteger(bursts) ||
    bursts < 1 ||
    delta.transfers !== bursts ||
    delta.entries !== bursts * 2 ||
    delta.keys !== bursts ||
    delta.badKeys !== 0
  )
    throw new Error("Duplicate cardinality failed");
}
async function verifyDuplicate(before, fixture, runId, bursts) {
  const after = await snapshot(fixture);
  const keys = await withDb(
    async (client) =>
      (
        await client.query(
          `SELECT count(*)::int AS keys,
    count(*) FILTER (WHERE k.response_code<>201 OR t.status<>'COMPLETED' OR t.id IS NULL OR
      (SELECT count(*) FROM ledger_entries l WHERE l.transfer_id=t.id)<>2)::int AS "badKeys"
    FROM idempotency_keys k LEFT JOIN transfers t ON t.id=k.transfer_id WHERE starts_with(k.idem_key,$1)`,
          [`${runId}:`],
        )
      ).rows[0],
  );
  const delta = {
    transfers: after.transfers - before.transfers,
    entries: after.entries - before.entries,
    ...keys,
  };
  assertDuplicateCounts(delta, bursts);
  console.log(
    JSON.stringify({ duplicateCardinality: "PASS", ...delta, bursts }),
  );
}
module.exports = { snapshot, verifyDuplicate, assertDuplicateCounts };
