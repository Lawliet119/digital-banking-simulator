import { expect, test } from '@playwright/test';
import { asUser, customerWithAccount, deposit, freshSub, signIn, tokenFor } from './support';

test('stage F: the operator finds an account by number, locks it with a reason, then unlocks it', async ({
  page,
  request,
}) => {
  const owner = await customerWithAccount(request, 'Ngô Bị Khóa');
  await signIn(page, 'operator', freshSub('operator'));
  await expect(page).toHaveURL(/\/operator\/accounts$/);
  await page.getByLabel('Tên khách, số tài khoản hoặc mã tài khoản').fill(owner.accountNumber);
  await page.getByRole('button', { name: 'Tìm' }).click();

  const row = page.getByTestId('operator-account-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Ngô Bị Khóa');
  await expect(row.getByTestId('account-status')).toHaveText('Hoạt động');
  await row.getByRole('button', { name: 'Khóa' }).click();
  const panel = page.getByTestId('lock-panel');
  await expect(panel.getByRole('button', { name: 'Xác nhận khóa' })).toBeDisabled();
  await panel.getByLabel('Lý do').fill('Khách báo mất điện thoại');
  await panel.getByRole('button', { name: 'Xác nhận khóa' }).click();
  await expect(row.getByTestId('account-status')).toHaveText('Bị khóa');

  await row.getByRole('button', { name: 'Mở khóa' }).click();
  await panel.getByLabel('Lý do').fill('Khách đã xác minh');
  await panel.getByRole('button', { name: 'Xác nhận mở khóa' }).click();
  await expect(row.getByTestId('account-status')).toHaveText('Hoạt động');
});

test('stage F: the operator deposits at the counter and the customer sees the money', async ({
  page,
  request,
}) => {
  const owner = await customerWithAccount(request, 'Bùi Nhận Nạp');
  await signIn(page, 'operator', freshSub('operator'));
  await page.getByRole('link', { name: 'Nạp tiền' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nạp tiền tại quầy');
  await page.getByLabel('Số tài khoản', { exact: true }).fill(owner.accountNumber);
  await page.getByRole('button', { name: 'Tìm' }).click();
  await expect(page.getByTestId('deposit-owner')).toHaveText('Bùi Nhận Nạp');
  await page.getByLabel('Số tiền (đồng)').fill('3.000.000');
  await page.getByRole('button', { name: 'Nạp tiền' }).click();
  await expect(page.getByTestId('deposit-done')).toContainText('3.000.000 ₫');

  const customer = asUser(request, await tokenFor(request, 'customer', owner.sub));
  const accounts = (await (await customer.get('/v1/accounts')).json()) as { balance: string }[];
  expect(accounts.map(account => account.balance)).toEqual(['3000000']);
});

test('stage F: the auditor pastes the correlation id of a transfer and sees its audit rows', async ({
  page,
  request,
}) => {
  const sender = await customerWithAccount(request, 'Kiểm Gửi');
  const receiver = await customerWithAccount(request, 'Kiểm Nhận');
  await deposit(request, sender.accountId, '200000');
  const customer = asUser(request, await tokenFor(request, 'customer', sender.sub));
  const sent = await customer.post(
    '/v1/transfers',
    { fromAccountId: sender.accountId, toAccountId: receiver.accountId, amount: '50000' },
    { 'Idempotency-Key': crypto.randomUUID() },
  );
  expect(sent.status()).toBe(201);
  const correlationId = sent.headers()['x-correlation-id'] ?? '';
  expect(correlationId).not.toBe('');

  await signIn(page, 'auditor', freshSub('auditor'));
  await expect(page).toHaveURL(/\/audit$/);
  await page.getByLabel('Mã truy vết (correlationId)').fill(correlationId);
  await page.getByRole('button', { name: 'Tra cứu' }).click();
  const rows = page.getByTestId('audit-row');
  await expect(rows.first()).toBeVisible();
  await expect(rows.filter({ hasText: 'transfer' }).first()).toBeVisible();
  // Read-only: the auditor's screen has no button that changes anything.
  await expect(page.getByRole('button', { name: /Khóa|Nạp|Chuyển|Lưu|Gửi/ })).toHaveCount(0);
});

test('stage F: the admin sees the version in force and the freeze warning on the new-version form', async ({
  page,
}) => {
  await signIn(page, 'admin', freshSub('admin'));
  await expect(page).toHaveURL(/\/admin\/risk-config$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Cấu hình luật gian lận');
  await page.getByRole('link', { name: 'Tạo phiên bản mới' }).click();
  await expect(page.getByTestId('freeze-warning')).toContainText('đóng băng cấu hình');
  await page.getByLabel('Cấu hình (JSON)').fill('[1, 2]');
  await page.getByRole('button', { name: 'Lưu phiên bản mới' }).click();
  await expect(page.getByRole('alert')).toHaveText('Cấu hình phải là một object JSON.');
  await page.getByLabel('Cấu hình (JSON)').fill('{"notARule": true}');
  await page.getByRole('button', { name: 'Lưu phiên bản mới' }).click();
  // The server, not the screen, decides what a valid configuration is.
  await expect(page.getByRole('alert').first()).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/risk-config\/new$/);
});

test('stage F: the fraud flag list loads for an operator and is blocked for a customer', async ({
  page,
  request,
}) => {
  await signIn(page, 'operator', freshSub('operator'));
  await page.getByRole('link', { name: 'Cờ gian lận' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Cờ gian lận');
  await expect(
    page.getByText('Không có cờ nào.').or(page.getByTestId('flag-row').first()),
  ).toBeVisible();

  const customer = await customerWithAccount(request, 'Tò Mò');
  const api = asUser(request, await tokenFor(request, 'customer', customer.sub));
  expect((await api.get('/v1/operator/fraud-flags')).status()).toBe(403);
});
