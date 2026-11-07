// Pure board logic for fetch-task.mjs, kept free of network calls so board.test.mjs can cover it.

export const ARCHIVE_TAB = 'Tài liệu đã chốt';
export const MAX_WEEK_TABS = 30;

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const headerIs = (rows, second) => rows.some((r) => (r[0] || '').trim() === 'Issue Key' && (r[1] || '').trim() === second);

// gviz answers an unknown tab name with the first (overview) tab and HTTP 200, so a tab only
// counts when its header row is really there.
export const isBoardTab = (rows) => headerIs(rows, 'Loại');
export const isArchiveTab = (rows) => headerIs(rows, 'Tuần cũ');

// Reads `Tuần 0`, `Tuần 1`, … until a tab is missing, repeats any earlier payload, or the cap is hit.
export async function probeTabs(loadText, max = MAX_WEEK_TABS) {
  const weeks = [];
  const seen = new Set();
  for (let w = 0; w < max; w++) {
    const tab = `Tuần ${w}`;
    const text = await loadText(tab);
    if (seen.has(text)) return { weeks, stop: 'duplicate', at: tab };
    seen.add(text);
    const rows = parseCsv(text);
    if (!isBoardTab(rows)) return { weeks, stop: 'missing', at: tab };
    weeks.push({ tab, rows });
  }
  return { weeks, stop: 'cap', at: `Tuần ${max}` };
}

const TASK_KEY = /^DBS-\d+$/;

// key -> { tab, r, archived }. Week rows win over the archive if a key is in both.
export function indexTasks(weeks, archiveRows) {
  const all = new Map();
  for (const r of archiveRows) {
    const k = (r[0] || '').trim();
    if (TASK_KEY.test(k)) all.set(k, { tab: ARCHIVE_TAB, r, archived: true });
  }
  for (const { tab, rows } of weeks)
    for (const r of rows) {
      const k = (r[0] || '').trim();
      if (TASK_KEY.test(k)) all.set(k, { tab, r, archived: false });
    }
  return all;
}

// 'done' | 'cancelled' | 'unknown' | 'open'. Only 'done' lets a dependent task start.
export function depState(key, all) {
  const d = all.get(key);
  if (!d) return 'unknown';
  if (d.archived) {
    const result = (d.r[4] || '').trim();
    if (/^done$/i.test(result)) return 'done';
    if (/hủy|huỷ|cancel/i.test(result)) return 'cancelled';
    return 'open';
  }
  return /^done$/i.test((d.r[5] || '').trim()) ? 'done' : 'open';
}

export const depsOf = (task) => [...new Set(((task.r[6] || '').match(/DBS-\d+/g) || []))];

export const blockedBy = (task, all) =>
  depsOf(task).map((key) => ({ key, state: depState(key, all) })).filter((d) => d.state !== 'done');

export const roleOf = (label) => (/fraud/i.test(label) ? 'fraud' : /platform|ops/i.test(label) ? 'ops' : 'dev');

const isToDo = (t) => !t.archived && /^(to do|)$/i.test((t.r[5] || '').trim());

// Tasks that block the most To Do tasks of the role, most first.
export function topBlockers(all, role) {
  const count = new Map();
  for (const t of all.values()) {
    if (!isToDo(t) || (role && roleOf(t.r[3] || '') !== role)) continue;
    for (const { key } of blockedBy(t, all)) count.set(key, (count.get(key) || 0) + 1);
  }
  return [...count.entries()]
    .map(([key, n]) => ({ key, count: n }))
    .sort((a, b) => b.count - a.count || Number(a.key.replace(/\D/g, '')) - Number(b.key.replace(/\D/g, '')));
}

export { isToDo };

// 'board' (DBS-n), 'off-board' (a key the board will never have), 'next', or 'invalid'.
export function classifyKey(arg) {
  const s = String(arg || '').trim();
  if (/^--next$/i.test(s)) return 'next';
  if (/^DBS-\d+$/i.test(s)) return 'board';
  if (/^(BUG|CHORE|DOCS|SKILL)-\d{8}-[a-z0-9][a-z0-9-]*$/i.test(s) || /^FRAUD-API-\d+$/i.test(s)) return 'off-board';
  return 'invalid';
}
