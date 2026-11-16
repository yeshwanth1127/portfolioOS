import { test, expect } from '@playwright/test';

const email = process.env.PLAYWRIGHT_LOGIN_EMAIL ?? 'owner@portfolio.local';
const password =
  process.env.PLAYWRIGHT_LOGIN_PASSWORD ?? process.env.DEMO_PASSWORD ?? 'password123';

test.beforeEach(() => {
  test.skip(
    !process.env.PLAYWRIGHT,
    'Set PLAYWRIGHT=1 with API (:4001) and web (:3001) running — see docs/PHASE2_EXIT.md',
  );
});

test('owner sees Overview v1 and opens Calendar', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.overview-v1')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.overview-hero h1')).not.toHaveText(/Loading/i);
  await page.getByRole('link', { name: 'Calendar' }).first().click();
  await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add event' })).toBeVisible();
});
