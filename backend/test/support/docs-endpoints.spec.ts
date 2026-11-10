import {
  compareEndpoints,
  parseDocsEndpoints,
  parseDocsErrorCodes,
  type SwaggerOperation,
} from './docs-endpoints';

const MARKDOWN = `
## 7. API (tổng quan)

| Method | Path | Vai trò | UC | Ghi chú |
|---|---|---|---|---|
| GET | \`/v1/identity/me\` | mọi vai trò đã đăng nhập | — | smoke |
| POST | \`/v1/transfers\` | customer | UC-5 | **Bắt buộc** \`Idempotency-Key\` |
| GET | \`/v1/audit/entries\` | auditor | UC-8 | Lọc |
| GET | \`/v1/admin/risk-config\` | admin | UC-12 | **Chưa triển khai (DBS-160).** Phiên bản hiện hành |
| GET | \`/health/live\`, \`/health/ready\` | — | — | Cho load balancer |

**Quy ước chung:**

### 7.1 Mã lỗi (\`errorCode\`)

| \`errorCode\` | HTTP | Khi nào | Quy tắc |
|---|---|---|---|
| \`ACCOUNT_NOT_ACTIVE\` | 422 | Tài khoản không ACTIVE | BR-05 |
| \`RATE_LIMITED\` | 429 | Vượt giới hạn | NFR-SEC-05 |

---

## 8. Data architecture
`;

const op = (
  method: string,
  path: string,
  roles: string[] | undefined,
  hasSecurity = true,
): SwaggerOperation => ({ method, path, roles, hasSecurity });

const ALLOW = new Set(['GET /v1/identity/me']);
const matching: SwaggerOperation[] = [
  op('GET', '/v1/identity/me', undefined),
  op('POST', '/v1/transfers', ['customer']),
  op('GET', '/v1/audit/entries', ['auditor']),
  op('GET', '/health/live', undefined, false),
  op('GET', '/health/ready', undefined, false),
];

describe('docs/03 section 7 versus Swagger (DBS-137)', () => {
  it('TC-137-08 reads each endpoint row, splits a cell with two paths and flags the planned row', () => {
    const rows = parseDocsEndpoints(MARKDOWN);
    expect(rows.map(r => `${r.method} ${r.path} ${r.roles}${r.planned ? ' planned' : ''}`)).toEqual(
      [
        'GET /v1/identity/me mọi vai trò đã đăng nhập',
        'POST /v1/transfers customer',
        'GET /v1/audit/entries auditor',
        'GET /v1/admin/risk-config admin planned',
        'GET /health/live —',
        'GET /health/ready —',
      ],
    );
  });

  it('TC-137-08 reads the error code table of section 7.1', () => {
    expect([...parseDocsErrorCodes(MARKDOWN)]).toEqual([
      ['ACCOUNT_NOT_ACTIVE', '422'],
      ['RATE_LIMITED', '429'],
    ]);
  });

  it('TC-137-08 reports nothing when Swagger equals the table, planned rows aside', () => {
    expect(compareEndpoints(parseDocsEndpoints(MARKDOWN), matching, ALLOW)).toEqual([]);
  });

  it('TC-137-08 names an extra route, a missing route and a wrong role', () => {
    const swagger = [
      ...matching.filter(o => o.path !== '/v1/audit/entries'),
      op('GET', '/v1/extra', ['operator']),
      ...[op('POST', '/v1/transfers', ['operator'])].slice(0, 0),
    ].map(o => (o.path === '/v1/transfers' ? { ...o, roles: ['operator'] } : o));
    const diffs = compareEndpoints(parseDocsEndpoints(MARKDOWN), swagger, ALLOW);
    expect(diffs).toEqual([
      'Swagger has GET /v1/extra but docs/03 §7 does not list it',
      'docs/03 §7 lists GET /v1/audit/entries but Swagger does not have it',
      'POST /v1/transfers: docs/03 says role "customer", Swagger x-roles is "operator"',
    ]);
  });

  it('TC-137-08 reports a planned row whose route already exists in Swagger', () => {
    const swagger = [...matching, op('GET', '/v1/admin/risk-config', ['admin'])];
    expect(compareEndpoints(parseDocsEndpoints(MARKDOWN), swagger, ALLOW)).toEqual([
      'GET /v1/admin/risk-config is marked "chưa triển khai" in docs/03 §7 but Swagger already has it',
    ]);
  });

  it('TC-137-08 holds "mọi vai trò đã đăng nhập" only for the no-role allowlist and "—" only for no security', () => {
    const swagger = matching.map(o =>
      o.path === '/health/live'
        ? { ...o, hasSecurity: true, roles: undefined }
        : o.path === '/v1/identity/me'
          ? { ...o, roles: ['customer'] }
          : o,
    );
    expect(compareEndpoints(parseDocsEndpoints(MARKDOWN), swagger, ALLOW)).toEqual([
      'GET /v1/identity/me: docs/03 says "mọi vai trò đã đăng nhập", Swagger x-roles is "customer"',
      'GET /health/live: docs/03 says public ("—"), Swagger has security',
    ]);
  });
});
