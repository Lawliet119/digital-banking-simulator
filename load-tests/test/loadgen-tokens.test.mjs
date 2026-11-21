import test from "node:test";
import assert from "node:assert/strict";
import { buildTokens, login, expOf, CUSTOMER_LABELS } from "../../infra/scripts/loadgen-tokens.mjs";

const jwt = (payload) =>
  `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2ln`;

const secret = {
  users: {
    operator: { email: "operator@example.invalid", password: "mat-khau-1" },
    customer1: { email: "c1@example.invalid", password: "mat-khau-2" },
    customer2: { email: "c2@example.invalid", password: "mat-khau-3" },
    customer3: { email: "c3@example.invalid", password: "mat-khau-4" },
  },
};

// TC-166-08: token của operator và ba khách đúng nhãn seed; mật khẩu chỉ nằm trong thân request, không trong URL/header.
test("buildTokens logs in four accounts and maps customers to the DBS-70 seed labels", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, headers: init.headers, user: body.AuthParameters.USERNAME, flow: body.AuthFlow });
    return {
      status: 200,
      json: async () => ({ AuthenticationResult: { AccessToken: jwt({ sub: body.AuthParameters.USERNAME, exp: 2000000000 }) } }),
    };
  };
  const tokens = await buildTokens({ clientId: "client-1", secret, fetchImpl });
  assert.deepEqual(Object.keys(tokens.customers), Object.values(CUSTOMER_LABELS));
  assert.equal(seen.length, 4);
  assert.ok(seen.every((s) => s.flow === "USER_PASSWORD_AUTH" && s.url.startsWith("https://cognito-idp.")));
  assert.ok(seen.every((s) => !JSON.stringify(s.headers).includes("mat-khau") && !s.url.includes("mat-khau")));
  assert.equal(expOf(tokens.operator), 2000000000);
  assert.equal(JSON.parse(Buffer.from(tokens.customers["demo-customer-minh-anh"].split(".")[1], "base64url")).sub, "c1@example.invalid");
});

// TC-166-09: Cognito từ chối hoặc trả thử thách thì dừng, không đưa token rỗng vào file.
test("login rejects non-200 and challenge responses", async () => {
  const bad = async () => ({ status: 400, json: async () => ({ __type: "NotAuthorizedException" }) });
  await assert.rejects(() => login({ clientId: "c", email: "a", password: "b" }, bad), /access token/);
  const challenge = async () => ({ status: 200, json: async () => ({ ChallengeName: "NEW_PASSWORD_REQUIRED" }) });
  await assert.rejects(() => login({ clientId: "c", email: "a", password: "b" }, challenge), /access token/);
  const notJwt = async () => ({ status: 200, json: async () => ({ AuthenticationResult: { AccessToken: "abc" } }) });
  await assert.rejects(() => login({ clientId: "c", email: "a", password: "b" }, notJwt), /access token/);
});

test("buildTokens fails when the secret lacks an account", async () => {
  const fetchImpl = async () => ({ status: 200, json: async () => ({}) });
  await assert.rejects(
    () => buildTokens({ clientId: "c", secret: { users: { operator: secret.users.operator } }, fetchImpl }),
    /access token|no customer1/,
  );
});
