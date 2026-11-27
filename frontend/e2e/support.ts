import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

export type Role = 'customer' | 'operator' | 'auditor' | 'admin';

/** A fresh subject per test, so nothing from an earlier run matters. */
export const freshSub = (role: Role) => `e2e-${role}-${randomUUID().slice(0, 8)}`;

/** A token from the dev server, the same one the sign-in screen gets. */
export async function tokenFor(request: APIRequestContext, role: Role, sub: string) {
  const response = await request.get(`/__dev-auth/token?role=${role}&sub=${sub}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

/** Calls the API through the dev server's proxy with a bearer token. */
export function asUser(request: APIRequestContext, token: string) {
  const headers = { Authorization: `Bearer ${token}` };
  return {
    get: (path: string) => request.get(path, { headers }),
    post: (path: string, data: unknown, extra: Record<string, string> = {}) =>
      request.post(path, { headers: { ...headers, ...extra }, data }),
  };
}

export interface Customer {
  sub: string;
  fullName: string;
  accountId: string;
  accountNumber: string;
}

/** A customer with a profile and one CHECKING account, made through the API. */
export async function customerWithAccount(
  request: APIRequestContext,
  fullName: string,
): Promise<Customer> {
  const sub = freshSub('customer');
  const api = asUser(request, await tokenFor(request, 'customer', sub));
  expect((await api.post('/v1/customers/me', { fullName })).status()).toBe(200);
  const opened = await api.post('/v1/accounts', { type: 'CHECKING' });
  expect(opened.status()).toBe(201);
  const body = (await opened.json()) as { id: string; accountNumber: string };
  return { sub, fullName, accountId: body.id, accountNumber: body.accountNumber };
}

/** An operator deposit (counter cash-in), as the operator screen will send it. */
export async function deposit(request: APIRequestContext, accountId: string, amount: string) {
  const api = asUser(request, await tokenFor(request, 'operator', freshSub('operator')));
  const response = await api.post(
    '/v1/operator/deposits',
    { toAccountId: accountId, amount },
    { 'Idempotency-Key': randomUUID() },
  );
  expect(response.status()).toBe(201);
}

/** Signs in through the sign-in screen. */
export async function signIn(page: Page, role: Role, sub: string) {
  const labels = {
    customer: 'Khách hàng',
    operator: 'Nhân viên',
    auditor: 'Kiểm toán viên',
    admin: 'Quản trị viên',
  };
  await page.goto('/login');
  await page.getByLabel(labels[role]).check();
  await page.getByLabel('Mã người dùng (sub)').fill(sub);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}
