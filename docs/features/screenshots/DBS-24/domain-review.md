<!-- Trả lời nguyên văn của reviewer (subagent Claude Opus 5.5, effort medium, 2026-10-19) cho design DBS-24 §1–§5, vòng 1. Không sửa. -->

| # | Severity | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|
| 1 | should-fix | §2.2, §2.4, TC-24-05, TC-24-10, TC-24-11 | The rule "exactly 1 issue per field" and the code each case expects cannot both hold with joi 18 as specified. I ran these checks against `node_modules/joi` 18.2.9 with `convert:false, abortEarly:false`. (a) `Joi.string().valid('TRANSFER','DEPOSIT')` given `5` or `null` returns **two** details on the same path, `any.only` and `string.base`. So TC-24-05 (`type`, `newStatus` set to a number or `null`) gets 2 issues instead of 1. (b) `Joi.valid(...)` without a base type gives only `any.only`, which maps to `NOT_ALLOWED`, not the `WRONG_TYPE` that TC-24-05 expects. (c) In the DEPOSIT branch (`then: Joi.valid(false)` / `Joi.boolean().valid(false)`), `sameOwner: "true"` gives `any.only` (+`boolean.base`) and `fromUserId: 5` gives `any.only`. TC-24-05 runs "boolean to `"true"`, uuid to number" on **every field of every sample**, the DEPOSIT sample included, and expects `WRONG_TYPE`; §2.4 only defines what happens for a uuid or `true`. | `node_modules/joi` probe; doc §2.2–§2.4, §4 | In §2, add an explicit mapping from joi `details.type` to the issue code: `any.required` → MISSING_FIELD; `*.base` → WRONG_TYPE; `string.empty`, `string.guid`, `string.pattern.*`, `any.custom` → INVALID_FORMAT; `any.only`, `any.unknown` → NOT_ALLOWED. Add a rule of one issue per path, with WRONG_TYPE winning over NOT_ALLOWED. State the DEPOSIT wrong-type cases (`fromUserId: 5` → WRONG_TYPE, `sameOwner: "true"` → WRONG_TYPE). Add test cases for `type: 5` and `newStatus: null` → exactly one WRONG_TYPE. |
| 2 | should-fix | §3 (type snippet), TC-24-19 | `interface EventBase { eventType: EventType }` with no literal `eventType` on each event means `DomainEvent` is **not** discriminated by `eventType`. I compiled the snippet with the repo's `tsconfig` (strict). Under `switch (e.eventType)`, `e.transferId` and `e.accountId` fail with TS2339, the `never` branch fails with TS2322, and a `TransferCompleted` carrying `eventType: 'AccountStatusChanged'` compiles with no error. That breaks TC-24-19 and the Expect (1) claim. With literals (`eventType: 'TransferCompleted'` on the common part, `'AccountStatusChanged'` on the other), all four TC-24-19 errors fire and the `never` switch compiles. | My `tsc` run (scratch file); doc §3 | Narrow `eventType` to a literal per event. Keep `EventType` as a union derived from them. |
| 3 | should-fix | §1, §2.5, §2.7, §3 "Thay đổi cấp hệ thống" | The design makes event-contract changes that were **not** among the questions approved at G1. (a) Times must be UTC ending in `Z`, `+00:00` refused, including `fromAccountCreatedAt`, which the contract only types as "ISO-8601". (b) `reason` is forbidden on `AccountStatusChanged`: the contract only says the event does not carry it. The skill says to stop and ask before changing the event contract. | SKILL.md line 25 ("Extra gate … the event contract"); event-contract table rows `fromAccountCreatedAt`, §AccountStatusChanged; doc §1 Q1–Q7 | List both changes as G2 questions, each with its rationale. The `Z`-only rule is reasonable because producers use `toISOString()`, but it is a contract change. |
| 4 | should-fix | §2.3, TC-24-06 | `Joi.string().uuid()` accepts `{6b1e…0a14}` (braces) and `6b1e4a529c0d4f7e8a312d5c7e9f0a14` (no hyphens). With `guid({separator:'-'})` it still accepts braces. All of TC-24-06's listed bad values are rejected anyway, so an implementation can pass every test while contradicting the "8-4-4-4-12" rule. Allowing upper case also admits non-canonical ids: Postgres treats them as equal, but Redis feature keys `risk:vel:{accountId}` / `risk:fan:{accountId}` and the fan-out members are plain strings, so R1 and R5 counts split. Producers always emit lower case (pg output). | joi probe; docs/03 §20 R-3 (line 642); database-design point 13 (uuid v4) | Use an explicit linear regex `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` (lower case only, or normalise). Add braces, no-hyphen and upper-case cases to TC-24-06. |
| 5 | should-fix | §5 M-24-04 | As written, M-24-04 fails for the wrong reason, so its pass criterion proves nothing. The scratchpad is on `C:` and the repo is on `F:`. A scratch `tsconfig` that `extends` `backend/tsconfig.json` inherits `outDir: ./dist`, and `tsc --noEmit` then fails with **TS5009 "Cannot find the common subdirectory path"** before checking any line. "Exit code non-zero" would therefore pass on that error. After overriding `"outDir": null, "incremental": false`, the `@common/*` alias and `baseUrl` resolve correctly (verified with `@common/money`). `@types/node` is not found from the scratch folder, so the throwaway file must not use `console` or Node globals. | My `npx tsc --noEmit -p <scratch>/tsconfig.json`, run from `backend/` | Give the exact scratch `tsconfig`: absolute `extends`, `outDir: null`, `incremental: false`, `include` the scratch file. Run it from `backend/`. Make the expected result "exactly 4 errors, at the 4 lines, with codes TS2322/TS2741…", not just "non-zero exit". |
| 6 | minor | §2.1, TC-24-06/17 | Joi's own messages echo the received value for patterns: `string.pattern.base` gives `"value" with value "secret-value-123" fails to match…`. The doc does not say that messages come from the issue code and never from `detail.message`. The tests would catch this only if a pattern rule is used. | joi probe | State in §2.1 that `message` is built from the issue code and never forwarded from joi. |
| 7 | minor | §2.2 NOT_AN_OBJECT | `Joi.object().validate(undefined)` returns **OK**, and `new Date()` / `new Map()` pass the object base check. So `NOT_AN_OBJECT` needs a pre-check (`typeof === 'object' && !== null && !Array.isArray`) before joi. That check also has to run before the `eventType` dispatch. | joi probe | Describe the pre-check in §2.1 and §2.2. |
| 8 | minor | §2.3/§2.4 | The validator accepts state that cannot be real. A `TRANSFER` with a negative `fromBalanceBefore` is impossible (BR-03, `accounts_balance_non_negative`). A `DEPOSIT` with `fromBalanceBefore > 0` is impossible too: `funding` is always ≤ 0 (ADR-09). R6 would just not fire, so the impact is low, but these corrupt events reach consumers instead of the DLQ. | database-design §accounts line 162; ADR-09; FRAUD guide line 149 | Either enforce `TRANSFER ⇒ fromBalanceBefore ≥ 0` and `DEPOSIT ⇒ ≤ 0` with tests, or write in §2.4 that this is deliberately not checked. |
| 9 | minor | §2.7, §2.8, TC-24-13 | Forbidding only the key `reason` is a name-based guard. `lockReason`, `fraudReason` and `note` all pass under "unknown fields allowed", so it does not really enforce BR-13. On the producer side, TS excess-property checking already rejects `reason` in an object literal. The rule is coherent but narrow. | event-contract §AccountStatusChanged; notification README "Phải giữ" | Keep it if approved at G2 (#3), but say in §2.7 that it is a tripwire, not the BR-13 control. The control stays in the notification template. |
| 10 | minor | §3, TC-24-20 | `Record<keyof TransferCompleted, …>` on `Common & (A \| B)` only sees keys that both branches share. A field added to only the DEPOSIT or only the TRANSFER branch would not make `typecheck` fail. | My `tsc` run (the TS2740 message lists `keyof Common \| "type" \| "fromUserId" \| "sameOwner"`) | Note this limit in §3, or require every new field to go on the common part. |
| 11 | minor | TC-24-19 | Where the errors land: a missing field and a DEPOSIT/TRANSFER branch mismatch are reported on the `const x: T =` line, while `amount: 500000` is reported on the property line. Prettier makes these literals multi-line, so `// @ts-expect-error -- …` must sit above different lines per case. Unused fixtures need a `_` prefix (eslint `varsIgnorePattern: '^_'`). | My `tsc` run (col 7 vs col 126); `backend/eslint.config.mjs` | Say this in TC-24-19 so the cases do not turn into "unused @ts-expect-error". |
| 12 | minor | §3 flowchart, §2.1 | The flowchart sends every `ok:false` to the DLQ. module-notes says a consumer "acknowledges a known-but-unhandled type". The design does not say what a consumer does with `UNKNOWN_EVENT_TYPE`. During a rolling deploy, an old worker would DLQ a newly added event type. | module-notes "Async, events and audit"; ADR-13 (one image, rolling) | State the policy: `UNKNOWN_EVENT_TYPE` → acknowledge and log, or DLQ, chosen deliberately. List it in the hand-offs. |

**Hand-offs (other developers' modules, not this design):**
- Deposit flow (DBS-60, BL-002 remainder): emit `fromUserId: null` and `sameOwner: false`; build `fromBalanceBefore` with `formatBalance` (negative); build every time with `Date#toISOString()`, never Postgres `to_json` output.
- BL-003 owner (sync guard): until a TRANSFER to or from SYSTEM is refused with `ACCOUNT_NOT_ACTIVE`, such a transfer would have `fromUserId` or `toUserId` null. `assertEvent` inside `OutboxWriter.add` would then throw, roll back the transaction and return a 500 instead of a 422.
- Outbox writer (DBS-57): `assertEvent` throws inside the business transaction, so a schema bug blocks every transfer (fail closed). That is intended, and it must be documented.
- Consumers (risk, notification): ack known-but-unhandled types, decide the `UNKNOWN_EVENT_TYPE` policy, use the codes and not the messages.
- `libs/sqs`: a `JSON.parse` failure goes straight to the DLQ (never reaches the validator).

Verdict: REVISE


---

<!-- Vòng 2 (2026-10-19): trả lời nguyên văn của reviewer (subagent Claude Opus 5.5, effort medium) cho §1–§6 sau khi sửa theo vòng 1. Không sửa. -->

| # | Severity | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|
| 1 | should-fix | §2.4 (luật liên trường), §2.1 step (4); TC-24-04, TC-24-05, TC-24-10, TC-24-11, TC-24-23 | New defect, introduced by the fix for round-1 #1. §2.4 says that for "mọi `type` khác (**kể cả giá trị sai**)" a `null` `fromUserId` is `WRONG_TYPE`, and then claims "một `type` sai (ví dụ `"WITHDRAWAL"`) chỉ cho đúng một lỗi, ở `type`". The claim is false whenever the rest of the payload has DEPOSIT shape (`fromUserId: null`): you get **two** issues, one at `type` and one `WRONG_TYPE` at `fromUserId`. This breaks tests that run over the DEPOSIT sample: TC-24-04 (drop `type`, expects exactly 1 issue), TC-24-05 (`type` set to a number or `null`, 1 issue), TC-24-10 (`type: "transfer"`), TC-24-23 (`type: 5` / `type: null`, "đúng một lỗi"), and TC-24-11 (`"WITHDRAWAL"` with the rest valid). It also contradicts §2.1 step (4), which says the cross-field rule runs only for fields that passed step 3: here it runs even though `type` failed. | The rule as written in doc §2.4. The joi probe (18.2.9, `convert:false, allowUnknown:true, abortEarly:false`) shows that `fromUserId: Joi.string().pattern(UUID).allow(null)` accepts `null` in step 3, so only step 4 emits the second issue. | Run the whole step 4 only when `type` passed step 3 (`TRANSFER` or `DEPOSIT`). When `type` failed, skip the `fromUserId`/`sameOwner` rule. Remove "(kể cả giá trị sai)". Add a case to TC-24-11/23: DEPOSIT sample with `type: 5` gives exactly 1 issue. |
| 2 | minor | §2.2 joi-to-`code` mapping; TC-24-13 | The mapping sends forbidden keys through `object.unknown`. With `allowUnknown: true`, joi never emits `object.unknown`. The natural way to forbid `reason` is `Joi.any().forbidden()`, which emits **`any.unknown`**, and that type is not in the mapping. So a literal implementation leaves `reason` with no code. Related: `forbidden()` accepts `reason: undefined`, while TC-24-13 says "bất kỳ giá trị". That is consistent with §2.2 (undefined counts as absent), but the test must not include `undefined`. | Probe: `reason:'x'` and `reason:null` give `any.unknown`, `reason:undefined` gives OK. Doc §2.2 says "`object.unknown` (khóa bị cấm)". | Replace `object.unknown` with `any.unknown`. Add a rule for unmapped joi types, for example throw in tests or fall back to `INVALID_FORMAT`. Change TC-24-13 to "any JSON value (including `null`)". |
| 3 | minor | TC-24-06 | "chữ hoa" runs on "mọi trường uuid" of every sample. The DEPOSIT sample's `fromAccountId` is the `funding` id `00000000-0000-4000-8000-000000000001`, which has no letters, so `toUpperCase()` returns the same, valid value. A generic loop then expects `INVALID_FORMAT` and gets `ok: true`. The DEPOSIT `fromUserId` is `null`, so it cannot be upper-cased either. | database-design.md line 573 (funding id); doc §2.3, §2.9 | In TC-24-06, run the upper-case variant only on ids that contain a-f, or use a fixed upper-case uuid. Skip `null` fields. |
| 4 | minor | TC-24-19 (round-1 #11 only partly fixed) | The text classifies where only three error kinds land. I compiled the §3 types with the repo `tsconfig` (TS 5.9.3, strict): `eventType: "Other"` (line 13 col 3) and `eventType: "AccountStatusChanged"` on a `TransferCompleted` land on the **property** line, like `amount: 500000`. Missing field, DEPOSIT with a string `fromUserId` and TRANSFER with a `null` `fromUserId` land on the `const` line (col 14). An `@ts-expect-error` placed by the doc's rule for these two eventType cases can be "unused". | My `tsc -p` run of a scratch copy of the §3 snippet | Add "`eventType` sai: dòng thuộc tính" to TC-24-19 and to M-24-04's line list. |

Verified as fixed. Round-1 #1: the joi side is correct. `type:5`, `type:null` and `newStatus:null` give `any.only` + `string.base`, so the priority rule yields one `WRONG_TYPE`. `fromUserId:5` gives `string.base`, `sameOwner:"true"` gives `boolean.base`, `""` gives `string.empty`, money gives `any.custom`, a pattern gives `string.pattern.base`. The cross-field side is row 1 above.
- #2: the literal `eventType` union narrows in `switch` with a `never` default and compiles. A wrong `eventType` errors.
- #3 and #9: left to G2, as stated.
- #4: §2.3 uses the lower-case regex, TC-24-06 extended.
- #5: tested with a scratch `tsconfig` on `C:` with absolute `extends`, `outDir:null`, `incremental:false`, `noEmit`. No TS5009, `@common/money` and its imports resolve with no extra errors, all errors are TS2322, and the errors land on the intended lines.
- #6: joi echoes the value in `string.pattern.base`; §2.1 now builds `message` from the code.
- #7: the pre-check is described in §2.1.
- #8: deliberate, pinned by TC-24-22.
- #10: confirmed. `Record<keyof Common & (A|B)>` misses keys that exist in only one branch, and the limit is documented. A missing key in a plain `Record` gives TS2741.
- #12: listed in the hand-off list.

Other checks:
- §2.9 examples: every uuid matches the lower-case regex, every time is UTC with `Z`, and the 3-issue example matches §2.2 and §2.4.
- `parseBalance` accepts `-2^63`, which matches TC-24-08.
- A JSON `__proto__` key does not pollute (probe).
- M-24-05 matches the DBS-22 `dist/common/...` layout.

Verdict: REVISE


---

<!-- Vòng 3 (2026-10-19): trả lời nguyên văn của reviewer (subagent Claude Opus 5.5, effort medium) cho §1–§6 sau khi sửa theo vòng 2. Không sửa. -->

| # | Severity (blocking / should-fix / minor) | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|
| 1 | minor | §2.2, the joi-to-`code` mapping paragraph | New defect. The mapping contradicts itself. "mọi `*.base` → `WRONG_TYPE`" also matches `string.pattern.base`, and the same paragraph lists `string.pattern.base` under `INVALID_FORMAT`. No rule says which one wins. An implementation that follows the text with `type.endsWith('.base')` sends every pattern failure (uuid, time) to `WRONG_TYPE`. That breaks TC-24-06, TC-24-09, the `occurredAt` row of the §2.9 example and the uuid case in M-24-02. The tests would catch it, but the spec gives the wrong instruction. | joi 18.2.9 probe: a bad uuid or a time with `+07:00` both give `string.pattern.base`; doc §2.2 | Write "`string.base`, `boolean.base` (the base type checks; not `string.pattern.base`) → `WRONG_TYPE`", or say that an exact match in the table wins over the `*.base` rule. |
| 2 | minor | §2.4 (type check), §2.2 mapping; TC-24-11, TC-24-05 | The doc does not say how to build the `fromUserId` schema ("uuid hoặc `null`"). With `Joi.alternatives().try(Joi.string().pattern(UUID), Joi.valid(null))`, `fromUserId: 5` and `true` give `alternatives.types`. That type is unmapped, so it falls back to `INVALID_FORMAT`, while TC-24-11 and TC-24-05 expect `WRONG_TYPE`. With `Joi.string().pattern(UUID).allow(null).required()`, the doc's expectations all hold. | Probe: `alternatives` gives `["alternatives.types"]` for 5 and true; `string().pattern().allow(null)` gives `string.base` for 5 and `string.pattern.base` for "abc" | In §2.4, name the schema shape `Joi.string().pattern(UUID).allow(null).required()`, or map `alternatives.types` → `WRONG_TYPE`. |

**Round-2 findings, checked against the doc text (not only §6). All are fixed.**
- **#1 (should-fix):** §2.1 step (4) and §2.4 now run the cross-field rule only when `type` passed step 3, and "(kể cả giá trị sai)" is gone. I applied the §2.1 pipeline mechanically to the §2.9 sample, with `convert:false, allowUnknown:true, abortEarly:false`:
  - `type` set to `5` or `null` gives exactly one issue, `type`/`WRONG_TYPE` (`any.only` + `string.base`, folded by priority).
  - `"WITHDRAWAL"` and `"transfer"` give exactly one `type`/`NOT_ALLOWED`.
  - Removing `type` gives exactly one `type`/`MISSING_FIELD`.
  - The TRANSFER sample gives the same results.
- **#2:** §2.2 uses `any.unknown` and has the `INVALID_FORMAT` fallback. With `Joi.any().forbidden()`, `reason` set to `"x"`, `null`, `0`, `{}`, `[]` or `false` gives one `NOT_ALLOWED`. `reason: undefined` passes, which matches TC-24-13 excluding `undefined`.
- **#3:** TC-24-06 now limits the upper-case variant to uuids with a–f and skips `null` fields. Upper case, braces and `""` each give one `INVALID_FORMAT`. A 100000-character string finishes in about 0 ms.
- **#4:** I ran `tsc` (TS 5.9.3, the repo `tsconfig`, scratch config on `C:` with absolute `extends`, `outDir:null`, `incremental:false`, `noEmit`). It confirms the TC-24-19 and M-24-04 line placement:
  - On the property line: `amount: 500000` (18,3), `eventType: 'Other'` (35,3), and `'AccountStatusChanged'` on a `TransferCompleted` (49,3).
  - On the `const` line (col 14): a missing field, `DEPOSIT` with a string `fromUserId`, and `TRANSFER` with `null`.
  - All errors are TS2322. There is no TS5009. The `switch` with a `never` default compiles.

**Other checks**
- **TC-24-04 and TC-24-05, all fields of the DEPOSIT, TRANSFER and AccountStatusChanged samples:** I dropped each field in turn and changed each to the wrong type. Every case gives exactly one issue at that field, with the expected code.
- **DEPOSIT cases (TC-24-11):** `fromUserId` 5 → `WRONG_TYPE`; "abc" → `INVALID_FORMAT`, with the cross-field rule correctly skipped; `sameOwner` "true" or null → `WRONG_TYPE`; `sameOwner` true → `NOT_ALLOWED`.
- **TRANSFER cases (TC-24-11):** `fromUserId` null → `WRONG_TYPE`; key removed → `MISSING_FIELD`.
- **`newStatus` (TC-24-23):** null and 5 each give one `WRONG_TYPE`.
- **`eventType` (TC-24-14):** null or 5 → `WRONG_TYPE`; missing → `MISSING_FIELD`; wrong case → `UNKNOWN_EVENT_TYPE`.
- **§2.9 example:** exactly the 3 issues shown.
- **`__proto__` key:** no pollution. An `Object.create(null)` payload is accepted.
- **Consistency:** §2.2, §2.4, §4 and §6 agree. TC ids TC-24-01 to TC-24-24 are unique and consecutive.

Verdict: REVISE


---

<!-- Vòng 4 (2026-10-19): trả lời nguyên văn của reviewer (subagent Claude Opus 5.5, effort medium), vòng xác nhận ngắn sau khi sửa theo vòng 3. Không sửa. -->

| # | Severity (blocking / should-fix / minor) | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|
| — | — | — | No defects found. Both round-3 edits are in the text. They agree with each other, with §4 and with the §2.9 example. The probe results are in the notes below. | `docs/features/DBS-24-common-events-types-schema.md` §2.2 line 74, §2.4 line 93, §2.9, TC-24-05/06/09/11/23 | None |

Verdict: APPROVE

Notes (what I verified):

- **The two edits are present.**
  - §2.2 now maps only `string.base` and `boolean.base` to `WRONG_TYPE`, matched by exact name, and says it does not include `string.pattern.base`.
  - §2.4 names the schema `Joi.string().pattern(UUID).allow(null).required()` and bans `Joi.alternatives()`.
  - §6 round-3 rows #1 and #2 describe the same changes.
- **Probe setup.** joi 18.2.9, run from the sibling worktree's `backend/node_modules` because the dbs24 worktree has no `node_modules`. Options were `convert: false`, `allowUnknown: true`, `abortEarly: false`. The schema was written exactly as §2.3 and §2.4 describe. TRANSFER and DEPOSIT samples gave the same results, as follows:
  - **Bad `fromAccountId`** (`"ABC"`, or an upper-case uuid): `string.pattern.base` → `INVALID_FORMAT`. This matches TC-24-06.
  - **`occurredAt` with `+07:00`**: `string.pattern.base` → `INVALID_FORMAT`. This matches TC-24-09.
  - **`fromUserId: 5`**: `string.base` only → `WRONG_TYPE`. This matches TC-24-05 and TC-24-11, including the DEPOSIT case.
  - **`fromUserId: "abc"`**: `string.pattern.base` → `INVALID_FORMAT`. Because that field failed step 3, the cross-field rule skips it.
  - **`fromUserId: ""`**: `string.empty` → `INVALID_FORMAT`.
  - **`fromUserId: null`**: joi accepts it on both samples. The cross-field rule then gives `WRONG_TYPE` on TRANSFER (TC-24-11) and passes on DEPOSIT (TC-24-02).
  - **`fromUserId` missing**: `any.required` → `MISSING_FIELD`.
  - **`type: 5` and `type: null`**: joi reports both `any.only` and `string.base`. The priority rule reduces this to one `WRONG_TYPE`, and the cross-field rule is skipped. This matches TC-24-23.
- **The §2.9 example.** joi alone reports `amount` `string.base` and `occurredAt` `string.pattern.base`. The DEPOSIT rule then adds `NOT_ALLOWED` on `fromUserId`. That gives exactly the 3 issues the doc shows.
- **Other checks:**
  - `sameOwner: "true"` gives `boolean.base` → `WRONG_TYPE`.
  - `reason: null` and `reason: 5` under `forbidden()` give `any.unknown` → `NOT_ALLOWED`. This matches TC-24-13.
  - A null-prototype object passes joi.
  - A `__proto__` key from `JSON.parse` does not pollute `Object.prototype`.
  - joi's `value` is a copy of the input, not the input itself. The implementer must therefore return the input object, which §2.1 already requires.
  - The `any.custom` and `string.pattern.base` messages repeat the received value. §2.1's rule that `message` is a fixed sentence built from `code` is necessary, and TC-24-17 covers it.
- **Money rules.** `parsePositiveMoney` and `parseBalance` in `backend/src/common/money/money.ts` and `balance.ts` use `^(0|[1-9][0-9]*)$` and `^(0|-?[1-9][0-9]*)$` with range checks. This agrees with every row of the §2.6 table and with TC-24-07 and TC-24-08.
- **Second read of §2–§6.** I found no remaining statement that is ambiguous, contradictory or impossible to implement. The UTC-with-`Z` rule, lower-case uuids and the `reason` tripwire are still left to G2, as instructed.
