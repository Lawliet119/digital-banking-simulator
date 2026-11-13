import test from "node:test";
import assert from "node:assert/strict";
import {
  assertTokensOutliveRun,
  cleanUrl,
  validateFixture,
} from "../lib/config.js";

// BL-233: one case per wrong URL and per wrong token/fixture variant that DBS-165 rejects before load.

const BASE = "http://127.0.0.1:3000";
const NOW_MS = Date.UTC(2026, 10, 14, 12, 0, 0);
const NOW_S = NOW_MS / 1000;
const b64 = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "RS256" })}.${b64(claims)}.signature`;
const ACCOUNTS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const SUBS = ["demo-customer-minh-anh", "demo-customer-thu-ha", "demo-customer-van-binh"];
const fixture = (over = {}) => ({
  baseUrl: BASE,
  customers: ACCOUNTS.map((accountId, i) => ({
    accountId,
    sub: SUBS[i],
    token: jwt({ sub: SUBS[i], exp: NOW_S + 7200 }),
  })),
  ...over,
});
const withCustomer = (index, patch) => {
  const f = fixture();
  f.customers[index] = { ...f.customers[index], ...patch };
  return f;
};

test("TC-165-06 cleanUrl accepts an http(s) origin and drops trailing slashes", () => {
  assert.equal(cleanUrl("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.equal(cleanUrl("https://api.example.test/"), "https://api.example.test");
  assert.equal(cleanUrl("https://api.example.test///"), "https://api.example.test");
  assert.equal(cleanUrl("http://localhost:3000/v1"), "http://localhost:3000/v1");
});

for (const [label, value] of [
  ["undefined (BASE_URL not set)", undefined],
  ["null", null],
  ["a number", 3000],
  ["an object", { url: BASE }],
  ["an empty string", ""],
  ["a host without a scheme", "127.0.0.1:3000"],
  ["a bare word", "localhost"],
  ["a non-HTTP scheme (ftp)", "ftp://127.0.0.1:3000"],
  ["a non-HTTP scheme (file)", "file:///etc/passwd"],
  ["a scheme with nothing after it", "http://"],
  ["a URL with a space inside", "http://127.0.0.1:3000/a b"],
  ["a URL with a leading space", " http://127.0.0.1:3000"],
  ["a URL with a trailing newline", "http://127.0.0.1:3000\n"],
  ["a URL with a query string", "http://127.0.0.1:3000/?token=abc"],
  ["a URL with a fragment", "http://127.0.0.1:3000/#section"],
  ["a URL with credentials (userinfo)", "http://user:secret@127.0.0.1:3000"],
  ["a URL with a user name only", "http://user@127.0.0.1:3000"],
]) {
  test(`TC-165-06 cleanUrl rejects ${label}`, () => {
    assert.throws(() => cleanUrl(value), /Invalid fixture URL/);
  });
}

test("TC-165-06 cleanUrl never echoes the rejected value (it may hold a credential)", () => {
  for (const secret of ["http://user:hunter2@host", "http://host/?token=hunter2"]) {
    try {
      cleanUrl(secret);
      assert.fail("expected rejection");
    } catch (error) {
      assert(!String(error.message).includes("hunter2"));
    }
  }
});

test("TC-165-06 validateFixture accepts a complete fixture, also when only the trailing slash of the target differs", () => {
  assert.doesNotThrow(() => validateFixture(fixture(), BASE));
  assert.doesNotThrow(() => validateFixture(fixture(), `${BASE}/`));
  assert.doesNotThrow(() => validateFixture(fixture({ baseUrl: `${BASE}//` }), BASE));
});

for (const [label, value] of [
  ["undefined", undefined],
  ["null", null],
  ["an empty object", {}],
  ["customers missing", { baseUrl: BASE }],
  ["customers that is not an array", { baseUrl: BASE, customers: "none" }],
  ["customers as an object keyed by sub", { baseUrl: BASE, customers: { a: {}, b: {}, c: {} } }],
  ["no customers", fixture({ customers: [] })],
  ["one customer", fixture({ customers: fixture().customers.slice(0, 1) })],
  ["two customers", fixture({ customers: fixture().customers.slice(0, 2) })],
  [
    "four customers",
    fixture({
      customers: [
        ...fixture().customers,
        { accountId: "44444444-4444-4444-8444-444444444444", sub: "x", token: jwt({}) },
      ],
    }),
  ],
]) {
  test(`TC-165-06 validateFixture rejects ${label}`, () => {
    assert.throws(() => validateFixture(value, BASE), /Invalid fixture customers/);
  });
}

for (const [label, patch] of [
  ["a fixture without baseUrl", { baseUrl: undefined }],
  ["a baseUrl that is not a URL", { baseUrl: "not a url" }],
  ["a baseUrl with a query", { baseUrl: `${BASE}/?x=1` }],
]) {
  test(`TC-165-06 validateFixture rejects ${label}`, () => {
    assert.throws(() => validateFixture(fixture(patch), BASE), /Invalid fixture URL/);
  });
}

for (const [label, other] of [
  ["another host", "http://10.0.0.5:3000"],
  ["another port", "http://127.0.0.1:3001"],
  ["another scheme", "https://127.0.0.1:3000"],
]) {
  test(`TC-165-06 validateFixture rejects a fixture built for ${label}`, () => {
    assert.throws(
      () => validateFixture(fixture({ baseUrl: other }), BASE),
      /Fixture target mismatch/,
    );
  });
}

test("TC-165-06 validateFixture rejects a run whose BASE_URL is invalid", () => {
  assert.throws(() => validateFixture(fixture(), undefined), /Invalid fixture URL/);
  assert.throws(() => validateFixture(fixture(), "ftp://x"), /Invalid fixture URL/);
});

for (const [label, patch] of [
  ["a missing accountId", { accountId: undefined }],
  ["an empty accountId", { accountId: "" }],
  ["an accountId shorter than a UUID", { accountId: "1111-2222" }],
  ["an accountId longer than a UUID", { accountId: `${ACCOUNTS[0]}0` }],
  ["an accountId with non-hex characters", { accountId: "zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz" }],
  ["a missing sub", { sub: undefined }],
  ["an empty sub", { sub: "" }],
  ["a missing token", { token: undefined }],
  ["an empty token", { token: "" }],
  ["a token that is not a string", { token: 12345 }],
  ["a token with one part", { token: "abcdef" }],
  ["a token with two parts", { token: "aaa.bbb" }],
  ["a token with four parts", { token: "aaa.bbb.ccc.ddd" }],
  ["a token with an empty header", { token: ".bbb.ccc" }],
  ["a token with an empty payload", { token: "aaa..ccc" }],
  ["a token with an empty signature", { token: "aaa.bbb." }],
  ["a token with a space", { token: "aaa.bb b.ccc" }],
  ["a token with a Bearer prefix", { token: "Bearer aaa.bbb.ccc" }],
  ["a token with characters outside base64url", { token: "aaa.b+b/=.ccc" }],
]) {
  test(`TC-165-06 validateFixture rejects ${label}`, () => {
    for (const index of [0, 2]) {
      assert.throws(
        () => validateFixture(withCustomer(index, patch), BASE),
        /Invalid fixture account\/token/,
      );
    }
  });
}

test("TC-165-06 validateFixture rejects a customer entry that is not an object", () => {
  const f = fixture();
  f.customers[1] = null;
  assert.throws(() => validateFixture(f, BASE));
});

test("TC-165-06 validateFixture rejects the same account used for two customers", () => {
  const f = fixture();
  f.customers[1].accountId = f.customers[0].accountId;
  assert.throws(() => validateFixture(f, BASE), /distinct accounts/);
  const same = fixture();
  same.customers.forEach((c) => (c.accountId = ACCOUNTS[0]));
  assert.throws(() => validateFixture(same, BASE), /distinct accounts/);
});

test("TC-165-06 validateFixture never echoes a token in its error", () => {
  const secret = "supersecret.payload.signature";
  try {
    validateFixture(withCustomer(0, { token: `${secret} x`, accountId: "bad" }), BASE);
    assert.fail("expected rejection");
  } catch (error) {
    assert(!String(error.message).includes("supersecret"));
  }
});

test("TC-165-06 tokens that belong to their customers and outlive the run are accepted", () => {
  assert.doesNotThrow(() => assertTokensOutliveRun(fixture(), 930, NOW_MS));
});

test("TC-165-06 the token may end exactly one minute after the run, not earlier", () => {
  const runSeconds = 930;
  const edge = (exp) =>
    withCustomer(1, { token: jwt({ sub: SUBS[1], exp }) });
  assert.doesNotThrow(() =>
    assertTokensOutliveRun(edge(NOW_S + runSeconds + 60), runSeconds, NOW_MS),
  );
  assert.throws(
    () => assertTokensOutliveRun(edge(NOW_S + runSeconds + 59), runSeconds, NOW_MS),
    /Token expires before run ends/,
  );
});

for (const [label, claims] of [
  ["already expired", { exp: NOW_S - 1 }],
  ["expiring before the run ends", { exp: NOW_S + 600 }],
  ["without an exp claim", {}],
  ["with exp as a string", { exp: String(NOW_S + 7200) }],
  ["with exp null", { exp: null }],
  ["with exp not a number", { exp: "never" }],
  ["issued for another subject", { sub: "demo-customer-someone-else", exp: NOW_S + 7200 }],
  ["without a sub claim", { sub: undefined, exp: NOW_S + 7200 }],
]) {
  test(`TC-165-06 a fixture token ${label} is rejected before load`, () => {
    const claimsFor = { sub: SUBS[2], ...claims };
    assert.throws(
      () =>
        assertTokensOutliveRun(
          withCustomer(2, { token: jwt(claimsFor) }),
          930,
          NOW_MS,
        ),
      /Token expires before run ends/,
    );
  });
}

test("TC-165-06 a token whose payload is not JSON fails closed", () => {
  const broken = `${b64({ alg: "RS256" })}.${Buffer.from("not json").toString("base64url")}.sig`;
  assert.throws(() =>
    assertTokensOutliveRun(withCustomer(0, { token: broken }), 930, NOW_MS),
  );
});

test("TC-165-06 a longer run needs a longer token (the check uses the scenario duration)", () => {
  const f = fixture();
  assert.doesNotThrow(() => assertTokensOutliveRun(f, 930, NOW_MS));
  assert.doesNotThrow(() => assertTokensOutliveRun(f, 7200 - 60, NOW_MS));
  assert.throws(
    () => assertTokensOutliveRun(f, 7200 - 59, NOW_MS),
    /Token expires before run ends/,
  );
});
