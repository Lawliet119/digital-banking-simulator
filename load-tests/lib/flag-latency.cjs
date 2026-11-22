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
const GAP_SECONDS = 10; // khoảng nghỉ k6 giữa hai plateau (`seconds + 10` ở load-tests/lib/config.js)

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

// Nạp tiền (DEPOSIT) cũng phát TransferCompleted lên queue risk: cần để so «gửi» của SQS với số sự kiện kỳ vọng (DBS-175).
const DEPOSITS_SQL = `
  SELECT count(*)::int AS deposits FROM transfers
   WHERE type = 'DEPOSIT' AND status = 'COMPLETED' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz`;

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
 * Cửa sổ của từng plateau theo thứ tự tăng dần của mức RPS. Dùng mốc thật `startedAt`/`endedAt` của `aggregate.json` khi có
 * (k6 xếp plateau cách nhau `seconds + 10` giây, nên không thể nối liền); thiếu mốc (aggregate.json cũ) thì nối từ `window.start`
 * và cộng GAP_SECONDS giữa hai plateau. Cửa sổ nửa mở [from, to): `to` là mốc cuối cộng 1 ms.
 * @returns {{label:string, from:string, to:string}[]}
 */
function plateauWindows(aggregate) {
  const plateaus = aggregate?.plateaus;
  if (!plateaus || typeof plateaus !== "object") return [];
  const out = [];
  let cursor = Date.parse(aggregate?.window?.start ?? "");
  for (const rate of Object.keys(plateaus).sort((a, b) => Number(a) - Number(b))) {
    const p = plateaus[rate];
    const first = Date.parse(p?.startedAt ?? "");
    const last = Date.parse(p?.endedAt ?? "");
    if (Number.isFinite(first) && Number.isFinite(last) && last >= first) {
      out.push({ label: `${rate}rps`, from: new Date(first).toISOString(), to: new Date(last + 1).toISOString() });
      cursor = last + 1 + GAP_SECONDS * 1000;
      continue;
    }
    const seconds = Number(p?.windowSeconds);
    if (!Number.isFinite(cursor) || !Number.isFinite(seconds) || seconds <= 0) continue;
    const end = cursor + Math.round(seconds * 1000);
    out.push({ label: `${rate}rps`, from: new Date(cursor).toISOString(), to: new Date(end).toISOString() });
    cursor = end + GAP_SECONDS * 1000;
  }
  return out;
}

/** Cả lượt (mọi bài, kể cả `hot-account` không có plateau): từ yêu cầu đầu tới yêu cầu cuối của `aggregate.json`. */
function runWindow(aggregate) {
  const first = Date.parse(aggregate?.window?.start ?? "");
  const last = Date.parse(aggregate?.window?.end ?? "");
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return null;
  return { label: "run", from: new Date(first).toISOString(), to: new Date(last + 1).toISOString() };
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
 * Nhãn ổn định trong một lượt đo: sắp mọi id tài khoản nguồn gặp ở mọi cửa sổ theo id rồi gán nguon-1.., nên cùng một tài khoản
 * giữ cùng nhãn giữa các cửa sổ; báo cáo không mang id thật. Sửa tại chỗ và trả lại `windows`.
 */
function labelSources(windows) {
  const ids = [...new Set(windows.flatMap(w => w.sourceAccountRows30d.map(r => String(r.account))))].sort();
  const label = new Map(ids.map((id, i) => [id, `nguon-${i + 1}`]));
  for (const w of windows) {
    w.sourceAccountRows30d = w.sourceAccountRows30d
      .map(r => ({ source: label.get(String(r.account)), rows30d: r.rows30d }))
      .sort((a, b) => a.source.localeCompare(b.source, "en", { numeric: true }));
  }
  return windows;
}

/**
 * Đo một cửa sổ. `client.query(sql, params)` trả `{ rows }` (pg.Client hoặc thứ tương đương). Gọi riêng thì nhãn nguồn là
 * nguon-1.. theo id đã sắp của chính cửa sổ này; `measure` gán nhãn chung cho cả lượt.
 * @returns {Promise<object>}
 */
async function measureWindow(client, window, { label = true } = {}) {
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
  const sources = (await client.query(SOURCE_ROWS_SQL, params)).rows.map(r => ({ account: r.account, rows30d: r.rows }));
  const deposits = (await client.query(DEPOSITS_SQL, params)).rows[0]?.deposits ?? 0;
  const transfers = summary?.transfers ?? 0;
  const decided = summary?.decided ?? 0;
  const decision = percentiles(summary?.decision_pct);
  const flag = percentiles(summary?.flag_pct);
  // Còn giao dịch chưa có quyết định thì p95 chỉ tính trên phần đã chấm: không được tuyên bố đạt (null = chưa kết luận được).
  const conclusive = transfers === decided;
  const result = {
    label: window.label,
    from: window.from,
    to: window.to,
    transfers,
    deposits,
    decided,
    undecided: transfers - decided,
    flagged: summary?.flagged ?? 0,
    decisionLagMs: { ...decision, max: round(summary?.decision_max), mean: round(summary?.decision_avg) },
    flagLagMs: { ...flag, max: round(summary?.flag_max), mean: round(summary?.flag_avg) },
    decisionP95UnderSlo: decision.p95 === null || !conclusive ? null : decision.p95 < SLO_MS,
    flagP95UnderSlo: flag.p95 === null || !conclusive ? null : flag.p95 < SLO_MS,
    modes,
    perMinute,
    sourceAccountRows30d: sources, // id thô; labelSources đổi thành nguon-N trước khi ra báo cáo
  };
  return label ? labelSources([result])[0] : result;
}

async function countUndecided(client, windows) {
  // Lấy lớn nhất, không cộng: cửa sổ `run` chứa các plateau nên cộng sẽ đếm đôi.
  let worst = 0;
  for (const w of windows) worst = Math.max(worst, (await client.query(UNDECIDED_SQL, [w.from, w.to])).rows[0].undecided);
  return worst;
}

/**
 * Đợi worker xử lý hết (không còn giao dịch nào chưa có quyết định trong mọi cửa sổ) tối đa `settleSeconds`, rồi đo.
 * `undecidedAfterSettle` là số giao dịch của cửa sổ rộng nhất còn thiếu quyết định (cửa sổ `run` gộp mọi plateau): đó là bằng
 * chứng tồn đọng và runner thoát khác 0.
 * @returns {Promise<{windows:object[], settledAfterSeconds:number, undecidedAfterSettle:number, backlog:boolean}>}
 */
async function measure(client, windows, { settleSeconds = 120, pollMs = 5000, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now } = {}) {
  const started = now();
  let undecided = await countUndecided(client, windows);
  while (undecided > 0 && now() - started < settleSeconds * 1000) {
    await sleep(pollMs);
    undecided = await countUndecided(client, windows);
  }
  const measured = [];
  for (const w of windows) measured.push(await measureWindow(client, w, { label: false }));
  labelSources(measured);
  return {
    sloMs: SLO_MS,
    settledAfterSeconds: Math.round((now() - started) / 100) / 10,
    undecidedAfterSettle: undecided,
    backlog: undecided > 0,
    windows: measured,
  };
}

module.exports = {
  SLO_MS,
  MINUTE_MS,
  GAP_SECONDS,
  plateauWindows,
  runWindow,
  parseWindow,
  labelSources,
  measureWindow,
  measure,
  countUndecided,
  SUMMARY_SQL,
  MINUTE_SQL,
  SOURCE_ROWS_SQL,
  DEPOSITS_SQL,
};
