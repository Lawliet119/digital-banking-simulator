import { expect, test, type Page } from '@playwright/test';

/** Each staff role: the radio label, its home and the heading of that home. */
const HOMES = {
  operator: ['Nhân viên', '/operator/accounts', 'Tìm tài khoản'],
  auditor: ['Kiểm toán viên', '/audit', 'Nhật ký kiểm toán'],
  admin: ['Quản trị viên', '/admin/risk-config', 'Cấu hình luật gian lận'],
} as const;

/** A visitor starts on the landing page and follows its sign-in link. */
async function signInFromLanding(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/welcome$/);
  await page.getByRole('link', { name: 'Đăng nhập' }).first().click();
  await expect(page).toHaveURL(/\/login$/);
}

/** A fresh subject per run, so no state from an earlier run matters. */
const sub = (role: string) => `e2e-${role}-${Date.now().toString(36)}`;

test('stage D: a new customer signs in and is sent to create a profile, as the server knows them', async ({
  page,
}) => {
  const subject = sub('customer');
  await signInFromLanding(page);
  await page.getByLabel('Mã người dùng (sub)').fill(subject);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByTestId('who')).toHaveText(subject);
});

for (const [role, [label, home, heading]] of Object.entries(HOMES)) {
  test(`stage D: ${role} signs in, lands on its home and the server knows the sub`, async ({
    page,
  }) => {
    const subject = sub(role);
    await signInFromLanding(page);
    await page.getByLabel(label).check();
    await page.getByLabel('Mã người dùng (sub)').fill(subject);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();

    await expect(page).toHaveURL(new RegExp(`${home}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
    await expect(page.getByTestId('who')).toHaveText(subject);
    await expect(page.getByTestId('who')).toHaveAttribute('title', label);
  });
}

test('stage D: a role page of another role is blocked in the UI', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Mã người dùng (sub)').fill(sub('customer'));
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.goto('/operator/fraud-flags');
  await expect(page.getByRole('alert')).toContainText('Không có quyền');
});

test('stage D: a token the server rejects sends the user back to sign in with a notice', async ({
  page,
}) => {
  await page.goto('/login');
  await page.evaluate(() => sessionStorage.setItem('dbs.token', 'not-a-token'));
  await page.goto('/accounts');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('status')).toHaveText('Phiên đã hết hạn hoặc bị thu hồi');
});

test('stage D: signing out forgets the token', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).toHaveURL(/\/(onboarding|accounts)$/);
  await page.getByRole('button', { name: 'Đăng xuất' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(await page.evaluate(() => sessionStorage.getItem('dbs.token'))).toBeNull();
});
