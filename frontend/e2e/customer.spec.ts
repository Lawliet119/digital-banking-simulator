import { expect, test } from '@playwright/test';
import { customerWithAccount, deposit, freshSub, signIn } from './support';

test('stage E: a new customer onboards, opens an account and sees a zero balance', async ({
  page,
}) => {
  await signIn(page, 'customer', freshSub('customer'));
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByLabel('Họ và tên').fill('Lê Thị Mới');
  await page.getByRole('button', { name: 'Tạo hồ sơ' }).click();

  await expect(page).toHaveURL(/\/accounts$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Chào Lê Thị Mới');
  await expect(page.getByText('Bạn chưa có tài khoản nào.')).toBeVisible();
  await page.getByRole('button', { name: 'Mở tài khoản' }).click();

  const row = page.getByTestId('account-row');
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('link')).toHaveText(/^\d{12}$/);
  await expect(row.getByTestId('balance')).toHaveText('0 ₫');
});

test('stage E: transfer by account number, confirm the name, see COMPLETED and the history', async ({
  page,
  request,
}) => {
  const sender = await customerWithAccount(request, 'Nguyễn Gửi');
  const receiver = await customerWithAccount(request, 'Trần Thị Nhận');
  await deposit(request, sender.accountId, '1000000');

  await signIn(page, 'customer', sender.sub);
  await expect(page.getByTestId('balance')).toHaveText('1.000.000 ₫');
  await page.getByRole('link', { name: 'Chuyển tiền' }).click();
  await page.getByLabel('Số tài khoản nhận').fill(receiver.accountNumber);
  await page.getByRole('button', { name: 'Kiểm tra' }).click();
  await expect(page.getByTestId('recipient')).toContainText('Trần Thị Nhận');
  await page.getByLabel('Số tiền (đồng)').fill('250.000');
  await page.getByRole('button', { name: 'Tiếp tục' }).click();

  await expect(page.getByTestId('recipient-name')).toHaveText('Trần Thị Nhận');
  await expect(page.getByTestId('confirm-amount')).toHaveText('250.000 ₫');
  await page.getByRole('button', { name: 'Chuyển', exact: true }).click();

  await expect(page).toHaveURL(/\/transfers\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('transfer-status')).toHaveText('Hoàn tất');
  await page.getByRole('link', { name: 'Về danh sách tài khoản' }).click();
  await expect(page.getByTestId('balance')).toHaveText('750.000 ₫');
  await page.getByRole('link', { name: sender.accountNumber }).click();
  const rows = page.getByTestId('history-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText(receiver.accountNumber);
  await expect(rows.first()).toContainText('250.000 ₫');
});

test('stage E: a transfer above the balance shows the reason and moves no money', async ({
  page,
  request,
}) => {
  const sender = await customerWithAccount(request, 'Phạm Thiếu');
  const receiver = await customerWithAccount(request, 'Đỗ Nhận');
  await deposit(request, sender.accountId, '100000');

  await signIn(page, 'customer', sender.sub);
  await page.goto('/transfer');
  await page.getByLabel('Số tài khoản nhận').fill(receiver.accountNumber);
  await page.getByRole('button', { name: 'Kiểm tra' }).click();
  await expect(page.getByTestId('recipient')).toBeVisible();
  await page.getByLabel('Số tiền (đồng)').fill('500000');
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  await page.getByRole('button', { name: 'Chuyển', exact: true }).click();

  await expect(page.getByTestId('reject-reason')).toContainText('Số dư không đủ.');
  await page.getByRole('link', { name: 'Xem giao dịch bị từ chối' }).click();
  await expect(page.getByTestId('transfer-status')).toHaveText('Bị từ chối');
  await expect(page.getByTestId('transfer-reason')).toHaveText('Số dư không đủ.');
  await page.goto('/accounts');
  await expect(page.getByTestId('balance')).toHaveText('100.000 ₫');
});

test('stage E: an unknown account number is reported before any transfer', async ({
  page,
  request,
}) => {
  const sender = await customerWithAccount(request, 'Vũ Tra');
  await signIn(page, 'customer', sender.sub);
  await page.goto('/transfer');
  await page.getByLabel('Số tài khoản nhận').fill('999999999999');
  await page.getByRole('button', { name: 'Kiểm tra' }).click();
  await expect(page.getByRole('alert')).toContainText('Không tìm thấy tài khoản với số này.');
  await expect(page.getByRole('button', { name: 'Tiếp tục' })).toBeDisabled();
});

test('stage E: the answer is lost after "Chuyển"; pressing again sends the same key and moves money once', async ({
  page,
  request,
}) => {
  const sender = await customerWithAccount(request, 'Hoàng Mất Mạng');
  const receiver = await customerWithAccount(request, 'Lý Nhận Một Lần');
  await deposit(request, sender.accountId, '500000');
  const keys: string[] = [];
  let dropped = false;
  await page.route('**/v1/transfers', async route => {
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    if (dropped) return route.continue();
    dropped = true;
    await route.fetch(); // the server receives it and moves the money…
    await route.abort('internetdisconnected'); // …but the answer never arrives
  });

  await signIn(page, 'customer', sender.sub);
  await page.goto('/transfer');
  await page.getByLabel('Số tài khoản nhận').fill(receiver.accountNumber);
  await page.getByRole('button', { name: 'Kiểm tra' }).click();
  await expect(page.getByTestId('recipient')).toBeVisible();
  await page.getByLabel('Số tiền (đồng)').fill('120000');
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  await page.getByRole('button', { name: 'Chuyển', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Chưa chắc giao dịch đã được thực hiện');
  await expect(page.getByRole('button', { name: 'Quay lại' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Chuyển', exact: true }).click();

  await expect(page.getByTestId('transfer-status')).toHaveText('Hoàn tất');
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  await page.goto('/accounts');
  await expect(page.getByTestId('balance')).toHaveText('380.000 ₫');
});

test("stage E: another customer's account and a made-up id are both just not found", async ({
  page,
  request,
}) => {
  const me = await customerWithAccount(request, 'Mai Một');
  const other = await customerWithAccount(request, 'Mai Hai');
  await signIn(page, 'customer', me.sub);
  await page.goto(`/accounts/${other.accountId}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Không tìm thấy');
  await page.goto('/accounts/00000000-0000-4000-8000-000000000999');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Không tìm thấy');
});

test('stage E: the notifications page loads for a customer', async ({ page, request }) => {
  const me = await customerWithAccount(request, 'Thông Báo');
  await signIn(page, 'customer', me.sub);
  await page.getByRole('link', { name: 'Thông báo' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thông báo');
  // Notices are written by the worker; with only the api running the list is empty.
  await expect(
    page.getByText('Chưa có thông báo.').or(page.getByTestId('notification').first()),
  ).toBeVisible();
});
