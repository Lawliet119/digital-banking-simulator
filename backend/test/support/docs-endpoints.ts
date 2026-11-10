/**
 * Reads the endpoint table (docs/03 §7) and the error code table (§7.1) and compares them with
 * the generated OpenAPI document (DBS-137, DoD 2 and 3). Paths are compared literally.
 */

export interface DocEndpoint {
  method: string;
  path: string;
  /** The "Vai trò" cell: a role name, "mọi vai trò đã đăng nhập" or "—". */
  roles: string;
  /** The "Ghi chú" cell says "Chưa triển khai": documented but not built yet. */
  planned: boolean;
}

export interface SwaggerOperation {
  method: string;
  path: string;
  roles: string[] | undefined;
  hasSecurity: boolean;
}

export const ANY_SIGNED_IN = 'mọi vai trò đã đăng nhập';
const PUBLIC = '—';

function section(markdown: string, from: RegExp, to: RegExp): string {
  const start = markdown.search(from);
  if (start < 0) throw new Error(`section not found: ${from.source}`);
  const rest = markdown.slice(start);
  const end = rest.slice(1).search(to);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map(cell => cell.trim());

export function parseDocsEndpoints(markdown: string): DocEndpoint[] {
  const body = section(markdown, /^## 7\. API/m, /^### 7\.1 /m);
  const rows: DocEndpoint[] = [];
  for (const line of body.split('\n')) {
    const [method, pathCell, roles, , note] = cells(line);
    if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method ?? '')) continue;
    const paths = [...pathCell.matchAll(/`([^`]+)`/g)].map(m => m[1]);
    for (const path of paths) {
      rows.push({ method, path, roles, planned: /chưa triển khai/i.test(note ?? '') });
    }
  }
  return rows;
}

/** Section 7.1: `errorCode` → HTTP status. */
export function parseDocsErrorCodes(markdown: string): Map<string, string> {
  const body = section(markdown, /^### 7\.1 /m, /^## 8\. /m);
  const codes = new Map<string, string>();
  for (const line of body.split('\n')) {
    const match = /^\|\s*`([A-Z][A-Z_]+)`\s*\|\s*(\d{3})\s*\|/.exec(line);
    if (match) codes.set(match[1], match[2]);
  }
  return codes;
}

/** Differences between the docs table and Swagger; `[]` when they agree. */
export function compareEndpoints(
  docs: readonly DocEndpoint[],
  swagger: readonly SwaggerOperation[],
  noRoleAllowlist: ReadonlySet<string>,
): string[] {
  const key = (method: string, path: string): string => `${method} ${path}`;
  const bySwagger = new Map(swagger.map(op => [key(op.method, op.path), op]));
  const diffs: string[] = [];
  const documented = new Set<string>();
  const missing: string[] = [];
  const roleDiffs: string[] = [];
  const plannedButPresent: string[] = [];

  for (const row of docs) {
    const k = key(row.method, row.path);
    const op = bySwagger.get(k);
    if (row.planned) {
      if (op)
        plannedButPresent.push(
          `${k} is marked "chưa triển khai" in docs/03 §7 but Swagger already has it`,
        );
      continue;
    }
    documented.add(k);
    if (!op) {
      missing.push(`docs/03 §7 lists ${k} but Swagger does not have it`);
      continue;
    }
    const swaggerRoles = (op.roles ?? []).join(', ');
    if (row.roles === PUBLIC) {
      if (op.hasSecurity) roleDiffs.push(`${k}: docs/03 says public ("—"), Swagger has security`);
    } else if (row.roles === ANY_SIGNED_IN) {
      if (!(op.hasSecurity && swaggerRoles === '' && noRoleAllowlist.has(k))) {
        roleDiffs.push(
          `${k}: docs/03 says "${ANY_SIGNED_IN}", Swagger x-roles is "${swaggerRoles}"`,
        );
      }
    } else {
      const expected = row.roles
        .split(',')
        .map(r => r.trim())
        .sort()
        .join(', ');
      const actual = [...(op.roles ?? [])].sort().join(', ');
      if (expected !== actual) {
        roleDiffs.push(
          `${k}: docs/03 says role "${row.roles}", Swagger x-roles is "${swaggerRoles}"`,
        );
      }
    }
  }
  for (const op of swagger) {
    const k = key(op.method, op.path);
    if (!documented.has(k) && !docs.some(row => row.planned && key(row.method, row.path) === k)) {
      diffs.push(`Swagger has ${k} but docs/03 §7 does not list it`);
    }
  }
  return [...diffs, ...missing, ...plannedButPresent, ...roleDiffs];
}
