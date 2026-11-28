import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { asUser, customerWithAccount, deposit, freshSub, signIn, tokenFor } from './support';

/** New in UI v2: what the new screens show. Notices and flags need the worker (APP_ROLE=both). */

const ASYNC = { timeout: 45_000 };

const money = (value: string) => `${new Intl.NumberFormat('vi-VN').format(BigInt(value))} ₫`;

async function transfer(
  request: APIRequestContext,
  sender: { sub: string; accountId: string },
  toAccountId: string,
  amount: string,
) {
  const api = asUser(request, await tokenFor(request, 'customer', sender.sub));
  const sent = await api.post(
    '/v1/transfers',
    { fromAccountId: sender.accountId, toAccountId, amount },
    { 'Idempotency-Key': randomUUID() },
  );
  expect(sent.status()).toBe(201);
  return {
    transferId: ((await sent.json()) as { transferId: string }).transferId,
    correlationId: sent.headers()['x-correlation-id'] ?? '',
  };
}

test('UI v2: a visitor reads the landing page and goes on to sign in', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Chuyển tiền trong vài giây.',
  );
  await page.getByRole('link', { name: 'Chuyển tiền ngay' }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('UI v2: both sides see amount and counterparty; summaries, limit and recent recipient follow', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(150_000);
  const sender = await customerWithAccount(request, 'Giang Gửi Tiền');
  const receiver = await customerWithAccount(request, 'Quách Nhận Tiền');
  await deposit(request, sender.accountId, '1000000');
  await transfer(request, sender, receiver.accountId, '250000');
  const api = asUser(request, await tokenFor(request, 'customer', sender.sub));
  const limits = (await (await api.get(`/v1/accounts/${sender.accountId}/limits`)).json()) as {
    remainingToday: string;
  };

  await signIn(page, 'customer', sender.sub);
  await expect(page.getByTestId('total-balance')).toHaveText('750.000 ₫');
  await expect(page.getByTestId('flow-in')).toHaveText('+1.000.000 ₫');
  await expect(page.getByTestId('flow-out')).toHaveText('−250.000 ₫');
  await expect(page.getByTestId('limit-remaining')).toHaveText(money(limits.remainingToday));

  await page.getByRole('link', { name: sender.accountNumber }).click();
  await expect(page.getByTestId('history-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Tiền ra' }).click();
  await expect(page.getByTestId('history-row')).toHaveCount(1);
  await expect(page.getByTestId('history-row')).toContainText('250.000 ₫');

  await page.goto('/notifications');
  const notices = page.getByTestId('notification');
  await expect(notices).toHaveCount(2, ASYNC);
  await page.getByRole('button', { name: 'Tiền ra' }).click();
  await expect(notices).toHaveCount(1);
  await expect(notices).toContainText('−250.000 ₫');
  await expect(notices).toContainText('Quách Nhận Tiền');
  await expect(notices).toContainText(receiver.accountNumber);
  await page.getByRole('button', { name: 'Tất cả' }).click();
  await expect(notices).toHaveCount(2);
  await page.getByRole('button', { name: 'Đánh dấu đã đọc' }).click();
  await expect(notices.getByText('Mới', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Đánh dấu đã đọc' })).toBeDisabled();

  await page.goto('/transfer');
  await expect(page.getByTestId('recent-recipient')).toContainText('Quách Nhận Tiền');
  await page.getByRole('button', { name: 'Chọn Quách Nhận Tiền' }).click();
  await expect(page.getByTestId('recipient')).toContainText('Quách Nhận Tiền');
  await page.getByRole('button', { name: '100.000 ₫', exact: true }).click();
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  await expect(page.getByTestId('confirm-amount')).toHaveText('100.000 ₫');
  await expect(page.getByText('650.000 ₫')).toBeVisible();

  const other = await (await browser.newContext()).newPage();
  await signIn(other, 'customer', receiver.sub);
  await other.goto('/notifications');
  const received = other.getByTestId('notification').first();
  await expect(received).toContainText('+250.000 ₫', ASYNC);
  await expect(received).toContainText('Giang Gửi Tiền');
});

test('UI v2: the flag list names both sides; the auditor opens one record', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const sender = await customerWithAccount(request, 'Cờ Người Gửi');
  const receiver = await customerWithAccount(request, 'Cờ Người Nhận');
  await deposit(request, sender.accountId, '21000000');
  const sent = await transfer(request, sender, receiver.accountId, '20000000');

  await signIn(page, 'operator', freshSub('operator'));
  await page.goto('/operator/fraud-flags');
  const row = page.getByTestId('flag-row').filter({ hasText: sent.transferId.slice(0, 8) });
  await expect(row).toContainText('Cờ Người Gửi → Cờ Người Nhận', ASYNC);
  await expect(row).toContainText('20.000.000 ₫');
  await expect(page.getByTestId('count-open')).toHaveText(/^[1-9]\d*$/);
  await row.getByRole('link').click();
  await expect(page.getByText('Tài khoản mới chuyển số tiền lớn').first()).toBeVisible();
  await expect(page.getByText(receiver.accountNumber).first()).toBeVisible();

  const auditor = await (await browser.newContext()).newPage();
  await signIn(auditor, 'auditor', freshSub('auditor'));
  await auditor.getByLabel('Mã truy vết (correlationId)').fill(sent.correlationId);
  await auditor.getByRole('button', { name: 'Tra cứu' }).click();
  await auditor.getByTestId('audit-row').first().getByRole('button').click();
  await expect(auditor.getByTestId('audit-record')).toContainText(sent.correlationId);
});

test('UI v2: the admin slider writes the weight into the configuration to be sent', async ({
  page,
}) => {
  await signIn(page, 'admin', freshSub('admin'));
  await expect(page.getByTestId('rule-card')).toHaveCount(6);
  await page.getByRole('link', { name: 'Tạo phiên bản mới' }).click();
  await expect(page).toHaveURL(/\/risk-config\/new$/);
  await page.getByRole('slider', { name: 'Trọng số R1' }).fill('45');
  const config = JSON.parse(await page.getByLabel('Cấu hình (JSON)').inputValue()) as {
    rules: Record<string, { weight: number }>;
  };
  expect(config.rules.R1?.weight).toBe(45);
});
