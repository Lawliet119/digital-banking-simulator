"use strict";
// DBS-174: độ trễ từ giao dịch tới quyết định và tới cờ, tính bằng SQL sau mỗi lượt đo. Chỉ đọc `transfers`, `risk_decisions`
// và `fraud_flags` (role `dbs_api` có SELECT trên cả ba; không đọc `outbox_events`, nó chỉ có INSERT).
//
// Định nghĩa (khớp `risk-scoring.consumer.ts`: `occurredAt` là `transfers.created_at`):
//   quyết định: risk_decisions.decided_at − transfers.created_at   (mọi giao dịch được chấm, cả LOW)
//   cờ:         fraud_flags.created_at   − transfers.created_at   (chỉ giao dịch MEDIUM/HIGH)
// Cờ và quyết định ghi trong cùng một transaction của worker, nên độ trễ quyết định là cận trên của độ trễ cờ cộng vài ms.

const SLO_MS = 5000; // docs/03 §14, ADR-03: p95 từ giao dịch tới cờ < 5 giây
const MINUTE_MS = 60_000;

/** @param {number|null|undefined} value */
function round(value) {
  return value === null || value === undefined || Number.isNaN(Number(value)) ? null : Math.round(Number(value) * 100) / 100;
}

const LAG_CTE = `
  WITH lag AS (
    SELECT tr.id, tr.from_account_id, tr.created_at, d.decided_at, d.mode, d.ai_status, f.created_at AS flagged_at,
           f.risk_level,
           EXTRACT(EPOCH FROM d.decided_at - tr.created_at) * 1000 AS decision_ms,
           EXTRACT(EPOCH FROM f.created_at - tr.created_at) * 1000 AS flag_ms
      FROM transfers tr
      LEFT JOIN risk_decisions d ON d.transfer_id = tr.id
      LEFT JOIN fraud_flags f ON f.transfer_id = tr.id
     WHERE tr.type = 'TRANSFER' AND tr.status = 'COMPLETED'
       AND tr.created_at >= $1::timestamptz AND tr.created_at < $2::timestamptz
  )`;

const SUMMARY_SQL = `${LAG_CTE}
  SELECT count(*)::int AS transfers, count(decided_at)::int AS decided, count(flagged_at)::int AS flagged,
         percentile_cont(ARRAY[0.5, 0.95, 0.99]) WITHIN GROUP (ORDER BY decision_ms) AS decision_pct,
         max(decision_ms) AS decision_max, avg(decision_ms) AS decision_avg,
         percentile_cont(ARRAY[0.5, 0.95, 0.99]) WITHIN GROUP (ORDER BY flag_ms) AS flag_pct,
         max(flag_ms) AS flag_max, avg(flag_ms) AS flag_avg
    FROM lag`;

const MODE_SQL = `${LAG_CTE}
  SELECT mode, ai_status, count(*)::int AS n FROM lag WHERE decided_at IS NOT NULL GROUP BY mode, ai_status ORDER BY mode, ai_status`;

const MINUTE_SQL = `${LAG_CTE}
  SELECT floor(EXTRACT(EPOCH FROM created_at - $1::timestamptz) / 60)::int AS minute, count(*)::int AS transfers,
         count(decided_at)::int AS decided, count(flagged_at)::int AS flagged,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY decision_ms) AS decision_p95, max(decision_ms) AS decision_max,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY flag_ms) AS flag_p95
    FROM lag GROUP BY 1 ORDER BY 1`;

// Số dòng lịch sử 30 ngày của mỗi tài khoản nguồn trong cửa sổ, tính tới cuối cửa sổ (đúng thứ extract đọc, docs DBS-173).
const SOURCE_ROWS_SQL = `
  SELECT t.from_account_id AS account, count(*)::int AS rows
    FROM transfers t
   WHERE t.from_account_id IN (
           SELECT DISTINCT from_account_id FROM transfers
            WHERE type = 'TRANSFER' AND status = 'COMPLETED' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz)
     AND t.type = 'TRANSFER' AND t.status = 'COMPLETED'
     AND t.created_at > $2::timestamptz - interval '30 days' AND t.created_at <= $2::timestamptz
   GROUP BY 1 ORDER BY 2 DESC`;

const UNDECIDED_SQL = `
  SELECT count(*)::int AS undecided FROM transfers tr
   WHERE tr.type = 'TRANSFER' AND tr.status = 'COMPLETED' AND tr.created_at >= $1::timestamptz AND tr.created_at < $2::timestamptz
     AND NOT EXISTS (SELECT 1 FROM risk_decisions d WHERE d.transfer_id = tr.id)`;

/** @param {unknown} pct @returns {{p50:number|null,p95:number|null,p99:number|null}} */
function percentiles(pct) {
  const [p50, p95, p99] = Array.isArray(pct) ? pct : [];
  return { p50: round(p50), p95: round(p95), p99: round(p99) };
}

/**
 * Cửa sổ của từng plateau, nối nhau từ `aggregate.window.start` theo thứ tự tăng dần của mức RPS (đúng thứ tự chạy của
 * `baseline` 12 → 60 → 120 và `stress`). Mỗi plateau dài `windowSeconds` của `aggregate.plateaus`.
 * @returns {{label:string, from:string, to:string}[]}
 */
function plateauWindows(aggregate) {
  const start = Date.parse(aggregate?.window?.start ?? "");
  const plateaus = aggregate?.plateaus;
  if (!Number.isFinite(start) || !plateaus || typeof plateaus !== "object") return [];
  const out = [];
  let cursor = start;
  for (const rate of Object.keys(plateaus).sort((a, b) => Number(a) - Number(b))) {
    const seconds = Number(plateaus[rate]?.windowSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    const end = cursor + Math.round(seconds * 1000);
    out.push({ label: `${rate}rps`, from: new Date(cursor).toISOString(), to: new Date(end).toISOString() });
    cursor = end;
  }
  return out;
}

/** @param {string} text `label=fromISO,toISO` */
function parseWindow(text) {
  const match = /^([\w.-]+)=([^,]+),(.+)$/.exec(text);
  if (!match || !Number.isFinite(Date.parse(match[2])) || !Number.isFinite(Date.parse(match[3])) || Date.parse(match[2]) >= Date.parse(match[3])) {
    throw new Error(`cửa sổ không hợp lệ: ${text} (dạng label=fromISO,toISO, from < to)`);
  }
  return { label: match[1], from: new Date(match[2]).toISOString(), to: new Date(match[3]).toISOString() };
}

/**
 * Đo một cửa sổ. `client.query(sql, params)` trả `{ rows }` (pg.Client hoặc thứ tương đương).
 * @returns {Promise<object>}
 */
async function measureWindow(client, window) {
  const params = [window.from, window.to];
  const [summary] = (await client.query(SUMMARY_SQL, params)).rows;
  const modes = (await client.query(MODE_SQL, params)).rows.map(r => ({ mode: r.mode, aiStatus: r.ai_status, decisions: r.n }));
  const perMinute = (await client.query(MINUTE_SQL, params)).rows.map(r => ({
    minute: r.minute,
    transfers: r.transfers,
    decided: r.decided,
    flagged: r.flagged,
    decisionP95Ms: round(r.decision_p95),
    decisionMaxMs: round(r.decision_max),
    flagP95Ms: round(r.flag_p95),
  }));
  const sources = (await client.query(SOURCE_ROWS_SQL, params)).rows.map((r, i) => ({ source: `nguon-${i + 1}`, rows30d: r.rows }));
  const transfers = summary?.transfers ?? 0;
  const decided = summary?.decided ?? 0;
  const decision = percentiles(summary?.decision_pct);
  const flag = percentiles(summary?.flag_pct);
  return {
    label: window.label,
    from: window.from,
    to: window.to,
    transfers,
    decided,
    undecided: transfers - decided,
    flagged: summary?.flagged ?? 0,
    decisionLagMs: { ...decision, max: round(summary?.decision_max), mean: round(summary?.decision_avg) },
    flagLagMs: { ...flag, max: round(summary?.flag_max), mean: round(summary?.flag_avg) },
    decisionP95UnderSlo: decision.p95 === null ? null : decision.p95 < SLO_MS,
    flagP95UnderSlo: flag.p95 === null ? null : flag.p95 < SLO_MS,
    modes,
    perMinute,
    sourceAccountRows30d: sources,
  };
}

async function countUndecided(client, windows) {
  let total = 0;
  for (const w of windows) total += (await client.query(UNDECIDED_SQL, [w.from, w.to])).rows[0].undecided;
  return total;
}

/**
 * Đợi worker xử lý hết (không còn giao dịch chưa có quyết định trong mọi cửa sổ) tối đa `settleSeconds`, rồi đo.
 * `undecided` còn lại sau hạn đợi là bằng chứng tồn đọng: runner thoát khác 0.
 * @returns {Promise<{windows:object[], settleSeconds:number, undecidedAfterSettle:number, backlog:boolean}>}
 */
async function measure(client, windows, { settleSeconds = 120, pollMs = 5000, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now } = {}) {
  const started = now();
  let undecided = await countUndecided(client, windows);
  while (undecided > 0 && now() - started < settleSeconds * 1000) {
    await sleep(pollMs);
    undecided = await countUndecided(client, windows);
  }
  const measured = [];
  for (const w of windows) measured.push(await measureWindow(client, w));
  return {
    sloMs: SLO_MS,
    settledAfterSeconds: Math.round((now() - started) / 100) / 10,
    undecidedAfterSettle: undecided,
    backlog: undecided > 0,
    windows: measured,
  };
}

module.exports = { SLO_MS, MINUTE_MS, plateauWindows, parseWindow, measureWindow, measure, countUndecided, SUMMARY_SQL, MINUTE_SQL, SOURCE_ROWS_SQL };
