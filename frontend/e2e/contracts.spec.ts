import { expect, test } from '@playwright/test';
import { freshSub, signIn } from './support';

/**
 * BL-042: the flag screen shows the server's `score`, never a sum of rule weights; the rule list
 * may be empty when only the AI raised the flag, and the AI part is shown on its own. The detail
 * response is replaced here, because the local stack runs `rule_only` and never makes such a flag.
 */
test('BL-042: an AI-only flag shows the server score, no rule, and the AI part apart', async ({
  page,
}) => {
  const transferId = '3c1f3a9e-2d4b-4a57-8e0f-6b7d9c1a2e44';
  await page.route(`**/v1/operator/fraud-flags/${transferId}`, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        transferId,
        fromAccountId: '8b3609fb-96a7-434b-a7ba-2ba171955e6d',
        toAccountId: 'bf9c3419-51ff-4e55-b03c-3296f0419c03',
        score: 40,
        riskLevel: 'MEDIUM',
        reviewStatus: 'OPEN',
        ruleSetVersion: 3,
        createdAt: '2026-11-20T02:30:00.000000Z',
        hits: [],
        recentTransactions: [],
        aiAssessment: { status: 'OK', probability: 0.93, model: 'demo-model', rubricSha256: null },
      }),
    }),
  );
  await signIn(page, 'operator', freshSub('operator'));
  await page.goto(`/operator/fraud-flags/${transferId}`);
  await expect(page.getByTestId('flag-score')).toHaveText('40');
  await expect(page.getByTestId('flag-hit')).toHaveCount(0);
  await expect(page.getByText('Không có luật nào trúng (cờ có thể do AI tạo).')).toBeVisible();
  await expect(page.getByText('demo-model')).toBeVisible();
});

test('BL-042: with rules hit, the score is still the server value, not the sum of weights', async ({
  page,
}) => {
  const transferId = '4d2f4bae-3e5c-4b68-9f10-7c8e0d2b3f55';
  await page.route(`**/v1/operator/fraud-flags/${transferId}`, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        transferId,
        fromAccountId: '8b3609fb-96a7-434b-a7ba-2ba171955e6d',
        toAccountId: 'bf9c3419-51ff-4e55-b03c-3296f0419c03',
        // 35 + 30 = 65 by the rules; the server says 100 (capped with the AI part).
        score: 100,
        riskLevel: 'HIGH',
        reviewStatus: 'OPEN',
        ruleSetVersion: 3,
        createdAt: '2026-11-20T02:30:00.000000Z',
        hits: [
          { ruleId: 'R3', weight: 35, explanation: 'Tài khoản mới chuyển số tiền lớn' },
          { ruleId: 'R6', weight: 30, explanation: 'Chuyển gần hết số dư' },
        ],
        recentTransactions: [],
        aiAssessment: null,
      }),
    }),
  );
  await signIn(page, 'operator', freshSub('operator'));
  await page.goto(`/operator/fraud-flags/${transferId}`);
  await expect(page.getByTestId('flag-hit')).toHaveCount(2);
  await expect(page.getByTestId('flag-score')).toHaveText('100');
  await expect(page.getByText('Không có đánh giá AI cho giao dịch này.')).toBeVisible();
});

test('BL-235: the admin creates a new rule-set version from the one in force and sees it listed', async ({
  page,
}) => {
  await signIn(page, 'admin', freshSub('admin'));
  const current = page.getByTestId('latest-version');
  await expect(current).toHaveText(/^\d+$/);
  const before = Number(await current.textContent());

  await page.getByRole('link', { name: 'Tạo phiên bản mới' }).click();
  const editor = page.getByLabel('Cấu hình (JSON)');
  const config = JSON.parse(await editor.inputValue()) as {
    rules: Record<string, { weight: number }>;
  };
  const r1 = config.rules.R1;
  if (!r1) throw new Error('the version in force has no R1');
  r1.weight = r1.weight === 30 ? 31 : 30; // a real change, inside the allowed range
  await editor.fill(JSON.stringify(config, null, 2));
  await page.getByRole('button', { name: 'Lưu phiên bản mới' }).click();

  await expect(page).toHaveURL(/\/admin\/risk-config$/);
  await expect(current).toHaveText(String(before + 1));
  await expect(page.getByRole('button', { name: `Phiên bản ${before + 1}` })).toBeVisible();
});
