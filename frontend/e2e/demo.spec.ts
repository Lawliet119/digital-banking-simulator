import { expect, test, type Browser, type Page } from '@playwright/test';
import { asUser, customerWithAccount, deposit, freshSub, signIn, tokenFor } from './support';

/**
 * UI plan, stage G: the demo scenarios that need the whole system (api and worker, outbox, queues,
 * risk scoring, notifications). Scenarios 1, 3, 8, 9 and 11 of the plan are in customer.spec.ts,
 * staff.spec.ts and login.spec.ts; the table in frontend/README.md maps all eleven.
 *
 * Needs the backend with APP_ROLE=both (worker included) and ElasticMQ.
 */

/** Notices and flags arrive through the outbox relay and a queue: allow for a few polls. */
const ASYNC = { timeout: 45_000 };

async function newPage(browser: Browser): Promise<Page> {
  return (await browser.newContext()).newPage();
}

/** Sends a transfer through the screens and returns its id and the correlation id of the request. */
async function transferThroughUi(page: Page, toNumber: string, amount: string) {
  await page.goto('/transfer');
  await page.getByLabel('Số tài khoản nhận').fill(toNumber);
  await page.getByRole('button', { name: 'Kiểm tra' }).click();
  await expect(page.getByTestId('recipient')).toBeVisible();
  await page.getByLabel('Số tiền (đồng)').fill(amount);
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  const answer = page.waitForResponse(
    response => response.url().endsWith('/v1/transfers') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Chuyển', exact: true }).click();
  const response = await answer;
  expect(response.status()).toBe(201);
  await expect(page.getByTestId('transfer-status')).toHaveText('Hoàn tất');
  return {
    transferId: ((await response.json()) as { transferId: string }).transferId,
    correlationId: response.headers()['x-correlation-id'] ?? '',
  };
}

/** A transfer the default rules flag: a new account sends most of a large balance (R3 + R6). */
async function flaggedTransfer(page: Page, request: Parameters<typeof deposit>[0]) {
  const sender = await customerWithAccount(request, 'Tân Mở Mới');
  const receiver = await customerWithAccount(request, 'Khác Chủ Nhận');
  await deposit(request, sender.accountId, '21000000');
  await signIn(page, 'customer', sender.sub);
  const sent = await transferThroughUi(page, receiver.accountNumber, '20000000');
  return { sender, receiver, ...sent };
}

test('G2: the operator deposits through the screen; the customer sees the balance and a notice', async ({
  page,
  browser,
  request,
}) => {
  const owner = await customerWithAccount(request, 'Hà Nhận Nạp');
  await signIn(page, 'operator', freshSub('operator'));
  await page.goto('/operator/deposit');
  await page.getByLabel('Số tài khoản', { exact: true }).fill(owner.accountNumber);
  await page.getByRole('button', { name: 'Tìm' }).click();
  await page.getByLabel('Số tiền (đồng)').fill('10.000.000');
  await page.getByRole('button', { name: 'Nạp tiền' }).click();
  await expect(page.getByTestId('deposit-done')).toBeVisible();

  const customer = await newPage(browser);
  await signIn(customer, 'customer', owner.sub);
  await expect(customer.getByTestId('balance')).toHaveText('10.000.000 ₫');
  await customer.getByRole('link', { name: 'Thông báo' }).click();
  await expect(customer.getByTestId('notification').first()).toContainText(
    'Tài khoản của bạn vừa được nạp tiền',
    ASYNC,
  );
});

test('G4 G6 G7: a flagged transfer reaches the operator, is reviewed once, and the auditor sees the whole chain', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(150_000);
  const { transferId, correlationId } = await flaggedTransfer(page, request);
  expect(correlationId).not.toBe('');

  // G4: the flag shows up on the operator's list (it refreshes every 10 seconds).
  const operator = await newPage(browser);
  await signIn(operator, 'operator', freshSub('operator'));
  await operator.goto('/operator/fraud-flags');
  const link = operator.getByRole('link', { name: `${transferId.slice(0, 8)}…` });
  await expect(link).toBeVisible(ASYNC);

  // G6: two operators open the flag; the first review wins, the second is refused.
  await link.click();
  await expect(operator.getByTestId('flag-score')).toHaveText(/^\d+$/);
  const second = await newPage(browser);
  await signIn(second, 'operator', freshSub('operator'));
  await second.goto(`/operator/fraud-flags/${transferId}`);
  await expect(second.getByRole('button', { name: 'Gửi review' })).toBeVisible();

  await operator.getByLabel('Báo nhầm').check();
  await operator.getByRole('button', { name: 'Gửi review' }).click();
  await expect(operator.getByTestId('review-closed')).toBeVisible();
  await expect(operator.getByTestId('flag-review-status')).toHaveText('Báo nhầm');

  await second.getByLabel('Gian lận thật').check();
  await second.getByRole('button', { name: 'Gửi review' }).click();
  await expect(second.getByTestId('review-closed')).toHaveText('Cờ này đã được review.');

  // G7: the auditor pastes the correlation id and sees request, ledger, notice, flag and review.
  const auditor = await newPage(browser);
  await signIn(auditor, 'auditor', freshSub('auditor'));
  await auditor.getByLabel('Mã truy vết (correlationId)').fill(correlationId);
  await auditor.getByRole('button', { name: 'Tra cứu' }).click();
  const actions = auditor.getByTestId('audit-row').locator('td:nth-child(2)');
  await expect(async () => {
    const seen = await actions.allTextContents();
    for (const action of ['transfer', 'notification.sent', 'fraud.flagged', 'fraud_flag.review']) {
      expect(seen).toContain(action);
    }
  }).toPass(ASYNC);
});

test('G5: no customer screen says anything about fraud, flags, scores or AI', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const { sender, transferId } = await flaggedTransfer(page, request);
  // Wait until the flag exists, so the scan runs on a customer who really was flagged.
  const operator = asUser(request, await tokenFor(request, 'operator', freshSub('operator')));
  await expect(async () => {
    expect((await operator.get(`/v1/operator/fraud-flags/${transferId}`)).status()).toBe(200);
  }).toPass(ASYNC);

  const forbidden = /gian lận|fraud|\bcờ\b|flag|điểm rủi ro|\bscore\b|rủi ro|\bAI\b|review/i;
  for (const path of [
    '/accounts',
    `/accounts/${sender.accountId}`,
    `/transfers/${transferId}`,
    '/notifications',
    '/transfer',
  ]) {
    await page.goto(path);
    await expect(page.locator('main')).not.toBeEmpty();
    await page.waitForLoadState('networkidle');
    expect(await page.locator('body').innerText(), path).not.toMatch(forbidden);
  }
});

test("G10: the operator locks the customer's account; the customer's next action returns to sign in", async ({
  page,
  browser,
  request,
}) => {
  const owner = await customerWithAccount(request, 'Đinh Bị Thu Hồi');
  await signIn(page, 'customer', owner.sub);
  await expect(page.getByTestId('account-row')).toHaveCount(1);

  const operator = await newPage(browser);
  await signIn(operator, 'operator', freshSub('operator'));
  await operator.getByLabel('Tên khách, số tài khoản hoặc mã tài khoản').fill(owner.accountNumber);
  await operator.getByRole('button', { name: 'Tìm' }).click();
  const row = operator.getByTestId('operator-account-row');
  await row.getByRole('button', { name: 'Khóa' }).click();
  const panel = operator.getByTestId('lock-panel');
  await panel.getByLabel('Lý do').fill('Nghi ngờ bị chiếm tài khoản');
  await panel.getByRole('button', { name: 'Xác nhận khóa' }).click();
  await expect(row.getByTestId('account-status')).toHaveText('Bị khóa');

  await page.getByRole('link', { name: 'Chuyển tiền' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('status')).toHaveText('Phiên đã hết hạn hoặc bị thu hồi');
});
