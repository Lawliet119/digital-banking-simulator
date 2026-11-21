#!/usr/bin/env node
// DBS-166: lấy access token Cognito của operator và ba khách demo, ghi vào MỘT file JSON quyền 0600 đúng dạng
// `LOAD_TOKENS_FILE` của load-tests (README «Cognito và TLS»): {"operator": "<jwt>", "customers": {"<nhãn>": "<jwt>"}}.
// Chạy trên máy vận hành (admin), KHÔNG trên máy tải: máy tải không được đọc secret `dbs/dev/demo-accounts`.
// Mật khẩu đi từ `aws secretsmanager` vào bộ nhớ rồi vào thân HTTPS của InitiateAuth (API công khai của Cognito,
// không cần credential AWS); không vào argv, tệp tạm hay log. Token sống theo `access_token_validity` của app client
// (client tạm `dbs-loadgen` của stack envs/dev/loadgen: 240 phút; `dbs-app` của base giữ 15 phút, ADR-06).
//
// Dùng: COGNITO_CLIENT_ID=<id> AWS_PROFILE=dbs node infra/scripts/loadgen-tokens.mjs <file-ra>
// Thoát: 0 đã ghi file; 1 lỗi (không ghi file); 2 dùng sai.
import { execFileSync } from "node:child_process";
import { writeFileSync, chmodSync } from "node:fs";

// Nhãn kế hoạch seed của DBS-70 (backend/src/scripts/seed.ts SEED_CUSTOMERS) ứng với customer1..3 của demo-token.sh.
export const CUSTOMER_LABELS = {
  customer1: "demo-customer-minh-anh",
  customer2: "demo-customer-thu-ha",
  customer3: "demo-customer-van-binh",
};
const REGION = "ap-southeast-1";
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function readSecret(name = "dbs/dev/demo-accounts") {
  const out = execFileSync(
    "aws",
    ["secretsmanager", "get-secret-value", "--secret-id", name, "--region", REGION, "--query", "SecretString", "--output", "text"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return JSON.parse(out);
}

export async function login({ clientId, email, password }, fetchImpl = fetch) {
  const res = await fetchImpl(`https://cognito-idp.${REGION}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  const token = body?.AuthenticationResult?.AccessToken;
  if (res.status !== 200 || !JWT.test(token || "")) throw new Error("Cognito did not return an access token");
  return token;
}

export function expOf(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).exp;
}

export async function buildTokens({ clientId, secret, fetchImpl = fetch }) {
  const users = secret?.users ?? {};
  const tokens = { operator: await login({ clientId, ...pick(users, "operator") }, fetchImpl), customers: {} };
  for (const [role, label] of Object.entries(CUSTOMER_LABELS))
    tokens.customers[label] = await login({ clientId, ...pick(users, role) }, fetchImpl);
  return tokens;
}

function pick(users, role) {
  const u = users[role];
  if (!u?.email || !u?.password) throw new Error(`demo-accounts has no ${role}`);
  return { email: u.email, password: u.password };
}

async function main(argv) {
  const out = argv[0];
  const clientId = process.env.COGNITO_CLIENT_ID;
  if (argv.length !== 1 || !clientId) {
    console.error("Usage: COGNITO_CLIENT_ID=<id> node infra/scripts/loadgen-tokens.mjs <output-file>");
    return 2;
  }
  try {
    const tokens = await buildTokens({ clientId, secret: readSecret() });
    writeFileSync(out, JSON.stringify(tokens), { mode: 0o600 });
    chmodSync(out, 0o600);
    const minutes = Math.floor((Math.min(expOf(tokens.operator), ...Object.values(tokens.customers).map(expOf)) * 1000 - Date.now()) / 60000);
    console.log(`Wrote ${out}: operator + ${Object.keys(tokens.customers).length} customers, shortest token valid for about ${minutes} minutes`);
    return 0;
  } catch (error) {
    console.error(`Token fetch failed: ${error.message}`);
    return 1;
  }
}

if (process.argv[1]?.endsWith("loadgen-tokens.mjs")) {
  process.exitCode = await main(process.argv.slice(2));
}
