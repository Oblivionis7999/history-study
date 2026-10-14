import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

test('production PWA caches only static resources and requires confirmation to activate an update', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await page.getByLabel('用户名', { exact: true }).fill('e2e_admin');
  await page.getByLabel('登录密码', { exact: true }).fill('e2e-only-test-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '创建加密空间', exact: true })).toBeEnabled();
  await page.getByLabel('本机解锁口令', { exact: true }).fill('local-test-passphrase');
  await page.getByLabel('确认本机解锁口令', { exact: true }).fill('local-test-passphrase');
  await page.getByRole('button', { name: '创建加密空间', exact: true }).click();
  await page.getByRole('button', { name: '我已妥善保存，进入学习', exact: true }).click();
  await page.getByRole('button', { name: '开始通刷', exact: true }).click();
  await page.getByRole('button', { name: '开始练习', exact: true }).click();
  await page.locator('.option').first().click(); await expect(page.locator('.answer-result')).toBeVisible();
  const cache = await page.evaluate(async () => {
    const result: string[] = [];
    for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) result.push(new URL(request.url).pathname);
    return result;
  });
  expect(cache).toContain('/index.html'); expect(cache.some(path => path.startsWith('/api/'))).toBe(false);
  await context.setOffline(true); await page.getByRole('button', { name: '下一题', exact: true }).click(); await page.locator('.option').first().click();
  await expect(page.locator('.answer-result')).toBeVisible(); await context.setOffline(false);
  const original = readFileSync('dist/sw.js', 'utf8');
  try {
    writeFileSync('dist/sw.js', original.replace("const CACHE = 'study-shell-", "const CACHE = 'study-shell-updated-"));
    await page.evaluate(async () => { const registration = await navigator.serviceWorker.getRegistration(); await registration!.update(); });
    await expect(page.getByRole('button', { name: '更新并重新解锁', exact: true })).toBeVisible();
    await expect(page.locator('.question-stem')).toBeVisible();
    await page.getByRole('button', { name: '更新并重新解锁', exact: true }).click();
    await expect(page.getByRole('heading', { name: '解锁本机学习记录' })).toBeVisible();
    await page.getByLabel('本机解锁口令', { exact: true }).fill('local-test-passphrase'); await page.getByRole('button', { name: '解锁学习空间', exact: true }).click();
    await expect(page.locator('.practice-position strong')).toHaveText('2'); await expect(page.locator('.answer-result')).toBeVisible();
  } finally { writeFileSync('dist/sw.js', original); }
});
