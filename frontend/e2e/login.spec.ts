import { expect, test } from '@playwright/test';

const LABELS = {
  customer: 'Khách hàng',
  operator: 'Nhân viên',
  auditor: 'Kiểm toán viên',
  admin: 'Quản trị viên',
} as const;

/** A fresh subject per run, so no state from an earlier run matters. */
const sub = (role: string) => `e2e-${role}-${Date.now().toString(36)}`;

for (const [role, label] of Object.entries(LABELS)) {
  test(`stage D: ${role} signs in and sees the sub and role the server returns`, async ({
    page,
  }) => {
    const subject = sub(role);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel(label).check();
    await page.getByLabel('Mã người dùng (sub)').fill(subject);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();

    await expect(page).toHaveURL(new RegExp(`/${role}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(label);
    await expect(page.getByTestId('me-sub')).toHaveText(subject);
    await expect(page.getByTestId('me-roles')).toHaveText(label);
  });
}

test('stage D: a role page of another role is blocked in the UI', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Mã người dùng (sub)').fill(sub('customer'));
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).toHaveURL(/\/customer$/);
  await page.goto('/operator');
  await expect(page.getByRole('alert')).toContainText('Không có quyền');
});

test('stage D: a token the server rejects sends the user back to sign in with a notice', async ({
  page,
}) => {
  await page.goto('/login');
  await page.evaluate(() => sessionStorage.setItem('dbs.token', 'not-a-token'));
  await page.goto('/customer');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('status')).toHaveText('Phiên đã hết hạn hoặc bị thu hồi');
});

test('stage D: signing out forgets the token', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).toHaveURL(/\/customer$/);
  await page.getByRole('button', { name: 'Đăng xuất' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(await page.evaluate(() => sessionStorage.getItem('dbs.token'))).toBeNull();
});
