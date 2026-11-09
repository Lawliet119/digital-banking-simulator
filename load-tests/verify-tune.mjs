import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// CSV interchange only: this program can be given to the recipient without the generator.
const HEADER =
  "tx_id,occurred_at,from_account,to_account,from_customer,to_customer,amount,from_balance_before,from_account_created_at,to_account_created_at,is_fraud,scenario";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const FRAUD = new Set([
  "ATO_DRAIN",
  "MULE_FANOUT",
  "VELOCITY_BURST",
  "BUST_OUT",
  "ROUND_TRIP",
  "SLOW_DRIP",
  "STRUCTURING",
  "FAN_IN",
]);
const LEGIT = new Set([
  "NORMAL",
  "HN_RENT",
  "HN_SELF_TRANSFER",
  "HN_NEW_SALARY",
  "HN_GROUP_MEAL",
  "HN_BORROW_REPAY",
]);
const check = (condition) => {
  if (!condition) throw new Error("invalid tune CSV");
};
export function verifyTune(csv) {
  check(typeof csv === "string" && csv.endsWith("\n"));
  const [header, ...lines] = csv.trimEnd().split("\n");
  check(header === HEADER && lines.length > 0);
  const ids = new Set(),
    customers = new Set();
  let previous = "";
  for (const line of lines) {
    const r = line.split(",");
    check(r.length === 12);
    for (const i of [0, 2, 3, 4, 5]) check(UUID.test(r[i]));
    check(!ids.has(r[0]) && r[2] !== r[3]);
    ids.add(r[0]);
    customers.add(r[4]);
    customers.add(r[5]);
    for (const i of [1, 8, 9])
      check(
        Number.isFinite(Date.parse(r[i])) &&
          new Date(r[i]).toISOString() === r[i],
      );
    check(r[1] >= previous && r[8] < r[1] && r[9] < r[1]);
    previous = r[1];
    for (const i of [6, 7]) check(/^(?:0|[1-9]\d*)$/.test(r[i]));
    check(BigInt(r[6]) > 0n && BigInt(r[7]) >= BigInt(r[6]));
    check(
      (r[10] === "1" && FRAUD.has(r[11])) ||
        (r[10] === "0" && LEGIT.has(r[11])),
    );
  }
  return {
    transactions: lines.length,
    activeCustomers: customers.size,
    sha256: createHash("sha256").update(csv).digest("hex"),
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 3) throw new Error();
    process.stdout.write(
      JSON.stringify(verifyTune(readFileSync(process.argv[2], "utf8"))) + "\n",
    );
  } catch {
    process.stderr.write("Tune CSV validation failed\n");
    process.exitCode = 1;
  }
}
