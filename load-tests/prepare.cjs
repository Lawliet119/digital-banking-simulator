// Run through backend's ts-node registers; reuses DBS-70 instead of duplicating onboarding.
const { randomUUID } = require("node:crypto");
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const {
  runSeed,
  SEED_CUSTOMERS,
  OPERATOR_SUB,
} = require("../backend/src/scripts/seed.ts");
const { mintDevToken } = require("../backend/src/scripts/dev-auth.ts");

async function prepare() {
  const { cleanUrl } = await import("./lib/config.js");
  const baseUrl = cleanUrl(process.env.BASE_URL);
  let tokens;
  if (process.env.LOAD_TOKENS_FILE) {
    tokens = JSON.parse(readFileSync(process.env.LOAD_TOKENS_FILE, "utf8"));
  } else {
    if (!["test", "development"].includes(process.env.NODE_ENV))
      throw new Error("Local auth forbidden");
    const dir = resolve(process.env.AUTH_KEY_DIR || ".auth-local");
    const exp = Math.floor(Date.now() / 1000) + 14400;
    tokens = {
      operator: await mintDevToken({
        dir,
        exp,
        role: "operator",
        sub: OPERATOR_SUB,
      }),
      customers: {},
    };
    for (const c of SEED_CUSTOMERS)
      tokens.customers[c.sub] = await mintDevToken({
        dir,
        exp,
        role: "customer",
        sub: c.sub,
      });
  }
  const report = await runSeed({ baseUrl, tokens, quiet: true });
  const customers = [];
  for (const c of report.customers) {
    const account = c.accounts.find((a) => a.type === "CHECKING");
    const token = tokens.customers[c.sub];
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString(),
    );
    const headers = { Authorization: `Bearer ${token}` };
    const current = await fetch(`${baseUrl}/v1/accounts/${account.id}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (current.status !== 200) throw new Error("Cannot read seed account");
    const amount = 50000000n - BigInt((await current.json()).balance);
    if (amount > 0n) {
      const response = await fetch(`${baseUrl}/v1/operator/deposits`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.operator}`,
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          toAccountId: account.id,
          amount: amount.toString(),
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (response.status !== 201) throw new Error("API top-up failed");
    }
    customers.push({ accountId: account.id, token, sub: payload.sub });
  }
  const out = resolve(process.env.LOAD_FIXTURE);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ baseUrl, customers }), { mode: 0o600 });
  console.log(
    "Seed API complete: 3 customers, CHECKING budget >=50000000 VND; fixture stored privately",
  );
}
if (require.main === module)
  prepare().catch(() => {
    console.error(
      "Load seed failed (details suppressed to protect credentials); check API health/auth/limits",
    );
    process.exitCode = 1;
  });
module.exports = { prepare };
