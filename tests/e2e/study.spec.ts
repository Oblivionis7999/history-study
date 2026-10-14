import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const bank = JSON.parse(readFileSync('data/questions.json', 'utf8'));
const questions = Object.fromEntries(bank.questions.map((q: any) => [q.id, q]));
const PASSWORD = 'e2e-only-test-password', PHRASE = 'independent-local-passphrase', BACKUP = 'independent-backup-passphrase';
const headers = { 'X-Study-Request': '1' };
mkdirSync('artifacts/screenshots/v2', { recursive: true });
let recoveryCode = '';
let username = '', userId = '', errors: string[] = [];
let adminRequest: APIRequestContext;
test.beforeAll(async ({ playwright }) => {
  adminRequest = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:5174', extraHTTPHeaders: headers });
  expect((await adminRequest.post('/api/auth/login', { data: { username: 'e2e_admin', password: PASSWORD } })).ok()).toBeTruthy();
});
test.afterAll(async () => { await adminRequest.dispose(); });

async function makeUser(_request: APIRequestContext, name = 'u' + randomUUID().slice(0, 12)) {
  const r = await adminRequest.post('/api/admin/users', { headers, data: { username: name, display_name: name, password: PASSWORD } });
  expect(r.ok()).toBeTruthy(); return { username: name, ...(await r.json()) };
}
async function unlock(page: Page, phrase = PHRASE) {
  await expect(page.getByRole('button', { name: /^(创建加密空间|解锁学习空间)$/ })).toBeEnabled();
  await page.getByLabel('本机解锁口令', { exact: true }).fill(phrase);
  const confirm = page.getByLabel('确认本机解锁口令', { exact: true });
  if (await confirm.count()) {
    await confirm.fill(phrase); await page.getByRole('button', { name: '创建加密空间', exact: true }).click();
    recoveryCode = (await page.locator('.recovery-box code').textContent())!;
    await page.getByRole('button', { name: '我已妥善保存，进入学习', exact: true }).click();
  } else await page.getByRole('button', { name: '解锁学习空间', exact: true }).click();
  await expect(page.locator('.brand')).toBeVisible();
}
async function login(page: Page, name: string, phrase = PHRASE) {
  await page.goto('/');
  await page.getByLabel('用户名', { exact: true }).fill(name);
  await page.getByLabel('登录密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await unlock(page, phrase);
}
async function local(page: Page, path: string, method = 'GET', body?: unknown): Promise<any> {
  const result = await page.evaluate(async ({ path, method, body }) => (await import('/src/learning.ts')).localRequest(path, method, body), { path, method, body });
  if (method !== 'GET') await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  return result;
}
async function data(page: Page): Promise<any> { return page.evaluate(async () => (await import('/src/vault.ts')).readData()); }
async function start(page: Page, mode = 'category', extra: any = {}): Promise<any> {
  const s = await local(page, '/sessions', 'POST', { mode, ...extra });
  await page.evaluate(id => { history.pushState({}, '', '/?session=' + id); dispatchEvent(new PopStateEvent('popstate')); }, s.id);
  await expect(page.locator('.question-stem')).toHaveText(s.questions[s.cursor].stem); return s;
}
async function logout(page: Page) {
  await page.evaluate(async () => { const { remote } = await import('/src/api.ts'); await remote('/auth/logout', 'POST'); dispatchEvent(new Event('study-auth-expired')); });
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
}
test.beforeEach(async ({ page, request }) => {
  errors = []; page.on('pageerror', e => errors.push(e.message));
  const user = await makeUser(request); username = user.username; userId = user.id;
  await login(page, username);
});
test.afterEach(() => expect(errors).toEqual([]));

test('homepage, exact bank and all paper quotas with frozen orders', async ({ page }) => {
  await expect(page.getByRole('heading', { name: '温故，知新。' })).toBeVisible();
  await expect(page.locator('.theme-card')).toHaveCount(9);
  for (const [mode, quota] of [['paper80', [35, 35, 10]], ['paper20', [9, 9, 2]]] as const) {
    const s = await local(page, '/sessions', 'POST', { mode, shuffle_options: true });
    expect(new Set(s.question_ids).size).toBe(quota.reduce((a, b) => a + b, 0));
    expect(['single', 'multiple', 'judge'].map(t => s.questions.filter((q: any) => q.type === t).length)).toEqual(quota);
    expect(await local(page, '/sessions/' + s.id)).toEqual(s);
  }
  const a = await local(page, '/sessions', 'POST', { mode: 'full' });
  const b = await local(page, '/sessions', 'POST', { mode: 'full' });
  expect(a.question_ids).toHaveLength(700); expect(a.id).not.toBe(b.id);
  await page.screenshot({ path: 'artifacts/screenshots/v2/desktop-home.png', fullPage: true });
});

test('single grading, duplicate click, notes, favorite and refresh are durable', async ({ page }) => {
  const requests: string[] = []; page.on('request', r => { if (r.url().includes('/api/')) requests.push(r.url()); });
  const s = await start(page, 'category', { type: 'single' }), q = s.questions[0];
  const wrong = q.options.findIndex((o: any) => !questions[q.id].answer_ids.includes(o.id));
  await page.locator('.option').nth(wrong).click();
  await expect(page.locator('.option.incorrect')).toHaveCount(1);
  await expect(page.locator('.option.correct')).toHaveCount(1);
  await local(page, '/sessions/' + s.id + '/answers', 'POST', { revision: 0, question_id: q.id, selected: questions[q.id].answer_ids });
  expect((await data(page)).states[q.id].attempts).toBe(1);
  await page.getByRole('button', { name: '收藏本题', exact: true }).click();
  await page.getByRole('button', { name: '写笔记', exact: true }).click();
  await page.getByLabel('自己的记忆笔记').fill('这是 A 的独立加密笔记');
  await page.getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect.poll(async () => (await data(page)).states[q.id].note).toBe('这是 A 的独立加密笔记');
  await page.reload(); await unlock(page);
  await expect(page.locator('.option.incorrect')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '取消收藏', exact: true })).toBeVisible();
  expect(requests.some(url => /api\/(sessions|questions|dashboard|preferences|export|restore)/.test(url))).toBeFalsy();
  const stored = await page.evaluate(async () => {
    const db = await (await import('/src/vault.ts')).openDB();
    return new Promise<string>(resolve => { const r = db.transaction('vaults').objectStore('vaults').getAll(); r.onsuccess = () => resolve(JSON.stringify(r.result)); });
  });
  expect(stored).not.toContain('独立加密笔记'); expect(stored).not.toContain(PHRASE); expect(stored).not.toContain(q.id);
});

test('multiple exact-set scoring and self-test hides solutions until submission', async ({ page }) => {
  let s = await start(page, 'category', { type: 'multiple' });
  const q = s.questions[0], correct = questions[q.id].answer_ids;
  await page.locator('.option').nth(q.options.findIndex((o: any) => o.id === correct[0])).click();
  await expect(page.locator('.answer-result')).toHaveCount(0);
  await page.getByRole('button', { name: '提交答案', exact: true }).click();
  await expect(page.locator('.option.correct')).toHaveCount(correct.length);
  if (correct.length > 1) await expect(page.getByText('漏选', { exact: true })).toHaveCount(correct.length - 1);
  s = await start(page, 'paper20', { feedback: 'test' });
  await page.locator('.option').first().click();
  await expect(page.locator('.answer-result')).toHaveCount(0);
  await page.getByRole('button', { name: '问 AI', exact: true }).click();
  await expect(page.getByRole('button', { name: '讲解本题', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '收起AI侧栏', exact: true }).click();
  await page.getByRole('button', { name: '提前交卷', exact: true }).click();
  await page.getByRole('button', { name: '确认交卷', exact: true }).click();
  await expect(page.locator('.result-stats .stat').nth(2).locator('strong')).toHaveText('19');
  const saved = (await data(page)).sessions[s.id]; expect(saved.status).toBe('completed'); expect(Object.keys(saved.results)).toHaveLength(1);
});

test('auto-next only advances fresh correct answers and pauses for AI', async ({ page }) => {
  await local(page, '/preferences', 'PUT', { auto_next: true });
  const s = await start(page, 'category', { type: 'single' });
  // Re-enter updates dashboard preferences without losing session progress.
  await page.reload(); await unlock(page);
  const q = s.questions[0], index = q.options.findIndex((o: any) => questions[q.id].answer_ids.includes(o.id));
  await page.locator('.option').nth(index).click();
  await expect(page.locator('.practice-position strong')).toHaveText('2', { timeout: 6000 });
  await page.getByRole('button', { name: '上一题', exact: true }).click();
  await page.waitForTimeout(1800); await expect(page.locator('.practice-position strong')).toHaveText('1');
  await page.getByRole('button', { name: '下一题', exact: true }).click();
  const second = s.questions[1]; await page.getByRole('button', { name: '问 AI', exact: true }).click();
  await page.locator('.option').nth(second.options.findIndex((o: any) => questions[second.id].answer_ids.includes(o.id))).click();
  await page.waitForTimeout(1800); await expect(page.locator('.practice-position strong')).toHaveText('2');
});

test('AI streams, caches locally, follows question and safely renders markdown', async ({ page }) => {
  const s = await start(page, 'category', { type: 'single' });
  await page.getByRole('button', { name: '问 AI', exact: true }).click();
  await page.getByLabel('允许发送本题、当前选择和追问给服务器与 AI 供应商').check();
  await page.getByRole('button', { name: '讲解本题', exact: true }).click();
  await expect(page.locator('.ai-message.assistant h2')).toHaveText('模拟学习讲解');
  await expect.poll(async () => Object.keys((await data(page)).cache).length).toBe(1);
  let requests = 0; page.on('request', r => { if (r.url().endsWith('/api/ai/chat')) requests++; });
  await page.getByRole('button', { name: '讲解本题', exact: true }).click();
  await expect(page.locator('.ai-message.assistant')).toHaveCount(2); expect(requests).toBe(0);
  await page.screenshot({ path: 'artifacts/screenshots/v2/desktop-ai.png', fullPage: true });
  await page.getByRole('button', { name: '下一题', exact: true }).click();
  await expect(page.locator('.ai-context')).toContainText(s.questions[1].stem);
  await expect(page.locator('.ai-message')).toHaveCount(0);
  const history = (await data(page)).chats[s.questions[0].id + ':solution']; expect(history).toHaveLength(4);
});

test('A and B on one browser retain independent notes, answers, favorites and AI', async ({ page, request }) => {
  const a = username, b = await makeUser(request);
  const s = await start(page, 'category', { type: 'single' }), qid = s.question_ids[0];
  await page.locator('.option').first().click();
  await expect(page.locator('.answer-result')).toBeVisible();
  let state = (await data(page)).states[qid];
  await local(page, '/questions/' + qid + '/state', 'PATCH', { revision: state.revision, note: 'A 私有内容', favorite: true });
  await page.getByRole('button', { name: '问 AI', exact: true }).click();
  await page.getByLabel('允许发送本题、当前选择和追问给服务器与 AI 供应商').check();
  await page.getByRole('button', { name: '讲解本题', exact: true }).click();
  await expect.poll(async () => Object.keys((await data(page)).chats).length).toBe(1);
  await logout(page); await login(page, b.username, PHRASE + '-B');
  const bd = await data(page); expect(bd.states).toEqual({}); expect(bd.chats).toEqual({}); expect(bd.sessions).toEqual({});
  await start(page, 'category', { type: 'single' }); await page.locator('.option').first().click(); await expect(page.locator('.answer-result')).toBeVisible();
  state = (await data(page)).states[qid]; await local(page, '/questions/' + qid + '/state', 'PATCH', { revision: state.revision, note: 'B 私有内容', favorite: false });
  await page.getByRole('button', { name: '问 AI', exact: true }).click(); await page.getByLabel('允许发送本题、当前选择和追问给服务器与 AI 供应商').check(); await page.getByRole('button', { name: '给我提示', exact: true }).click();
  await expect.poll(async () => Object.keys((await data(page)).chats).length).toBe(1);
  await logout(page); await login(page, a);
  const ad = await data(page); expect(ad.states[qid].note).toBe('A 私有内容'); expect(ad.states[qid].favorite).toBe(true); expect(ad.chats[qid + ':hint']).toBeUndefined(); expect(ad.chats[qid + ':solution']).toHaveLength(2);
});

test('encrypted backup rejects tamper, wrong owner/version and supports rollback', async ({ page }) => {
  const s = await start(page, 'category', { type: 'single' }), qid = s.question_ids[0];
  await page.locator('.option').first().click(); await expect(page.locator('.answer-result')).toBeVisible();
  const result = await page.evaluate(async ({ phrase }) => {
    const v = await import('/src/vault.ts'), l = await import('/src/learning.ts');
    const original = await v.readData(), encrypted = await v.encryptBackup(original, phrase);
    const restored = await v.decryptBackup(encrypted, phrase); l.validateData(restored);
    const outcomes: string[] = [];
    for (const mode of ['password', 'tamper', 'owner', 'version', 'grade', 'statistics', 'missing-history']) {
      try {
        const candidate = structuredClone(restored);
        if (mode === 'password') await v.decryptBackup(encrypted, 'wrong-password-value');
        if (mode === 'tamper') await v.decryptBackup({ ...encrypted, exported_at: encrypted.exported_at + 1 }, phrase);
        if (mode === 'owner') { candidate.owner = 'different-user'; await l.restoreData(candidate); }
        if (mode === 'version') { candidate.bank_version = 'different-bank'; await l.restoreData(candidate); }
        if (mode === 'grade') { const s = Object.values(candidate.sessions)[0]; Object.values(s.results)[0].correct = !Object.values(s.results)[0].correct; await l.restoreData(candidate); }
        if (mode === 'statistics') { Object.values(candidate.states)[0].attempts = 99; await l.restoreData(candidate); }
        if (mode === 'missing-history') { candidate.sessions = {}; await l.restoreData(candidate); }
        outcomes.push('unexpected-pass');
      } catch { outcomes.push('rejected'); }
    }
    const stateId = Object.keys(original.states)[0];
    await v.transact(d => { d.states[stateId].note = '恢复前保留'; });
    await l.restoreData(restored); const after = await v.readData();
    await v.restorePrevious(); const rollback = await v.readData();
    return { outcomes, after: after.states[stateId].note, rollback: rollback.states[stateId].note, encrypted: JSON.stringify(encrypted) };
  }, { phrase: BACKUP });
  expect(result.outcomes).toEqual(Array(7).fill('rejected')); expect(result.after).toBe(''); expect(result.rollback).toBe('恢复前保留'); expect(result.encrypted).not.toContain(qid);
});

test('offline answers and notes save without server persistence', async ({ page, context }) => {
  const s = await start(page, 'category', { type: 'single' });
  await context.setOffline(true); await page.locator('.option').first().click();
  await expect(page.locator('.answer-result')).toBeVisible(); await expect(page.getByText(/当前离线：/)).toBeVisible();
  await page.getByRole('button', { name: '写笔记', exact: true }).click(); await page.getByLabel('自己的记忆笔记').fill('断网也保存在本机');
  await page.getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect.poll(async () => (await data(page)).states[s.question_ids[0]].note).toBe('断网也保存在本机');
  await context.setOffline(false); await page.reload(); await unlock(page);
  expect((await data(page)).states[s.question_ids[0]].note).toBe('断网也保存在本机');
});

test('quota failures and interrupted restoration preserve original ciphertext', async ({ page }) => {
  const s = await start(page, 'category', { type: 'single' });
  await page.locator('.option').first().click(); await expect(page.locator('.answer-result')).toBeVisible();
  const result = await page.evaluate(async () => {
    const v = await import('/src/vault.ts'), l = await import('/src/learning.ts'); const before = await v.readData();
    const replacement = structuredClone(before); replacement.prefs.auto_next = true;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) { if (this.name === 'vaults') throw new DOMException('quota', 'QuotaExceededError'); return put.apply(this, args); };
    let message = '';
    try { await l.restoreData(replacement); } catch (e) { message = (e as Error).message; }
    finally { IDBObjectStore.prototype.put = put; }
    return { message, same: JSON.stringify(before) === JSON.stringify(await v.readData()) };
  });
  expect(result.message).toContain('空间不足'); expect(result.same).toBe(true);
  expect((await data(page)).sessions[s.id].results).not.toEqual({});
});

test('separate local passphrase rotation survives account password reset', async ({ page, request }) => {
  await start(page); await page.locator('.option').first().click(); await expect(page.locator('.answer-result')).toBeVisible();
  await page.evaluate(async ({ old, next }) => (await import('/src/vault.ts')).changeUnlock(old, next), { old: PHRASE, next: PHRASE + '-new' });
  await adminRequest.patch('/api/admin/users/' + userId, { headers, data: { new_password: PASSWORD } });
  await page.reload(); await login(page, username, PHRASE + '-new');
  expect(Object.keys((await data(page)).states)).toHaveLength(1);
});

test('multiple tabs reject stale revisions and logout locks all tabs', async ({ page, context }) => {
  const s = await start(page, 'category', { type: 'single' });
  const second = await context.newPage(); await second.goto('/'); await unlock(second);
  await local(page, '/sessions/' + s.id + '/progress', 'PATCH', { revision: s.revision, cursor: 1 });
  const result = await second.evaluate(async ({ id, revision }) => { try { await (await import('/src/learning.ts')).localRequest('/sessions/' + id + '/progress', 'PATCH', { revision, cursor: 2 }); return ''; } catch (e) { return (e as Error).message; } }, { id: s.id, revision: s.revision });
  expect(result).toContain('其他标签页'); expect((await local(second, '/sessions/' + s.id)).cursor).toBe(1);
  await page.evaluate(async () => { await (await import('/src/api.ts')).remote('/auth/logout', 'POST'); (await import('/src/AuthShell.tsx')).broadcastAccount(); dispatchEvent(new Event('study-auth-expired')); });
  await expect(second.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  const locked = await second.evaluate(async () => (await import('/src/vault.ts')).activeOwner()); expect(locked).toBe(''); await second.close();
});

test('search, review ordering and statistics derive from actual local answers', async ({ page }) => {
  const s = await start(page, 'category', { type: 'single' }), qid = s.question_ids[0];
  await page.locator('.option').first().click(); await expect(page.locator('.answer-result')).toBeVisible();
  const state = (await data(page)).states[qid]; await local(page, '/questions/' + qid + '/state', 'PATCH', { revision: state.revision, uncertain: true, favorite: true });
  await page.getByRole('button', { name: '搜索与复习', exact: true }).first().click();
  await page.getByRole('searchbox').fill(qid); await expect(page.locator('.search-result')).toHaveCount(1);
  await page.getByLabel('学习状态', { exact: true }).selectOption('favorite'); await expect(page.locator('.search-result')).toHaveCount(1);
  await expect(page.locator('.search-result')).toContainText('标记不确定');
  const d = await local(page, '/dashboard'); expect(d.stats.answered).toBe(1); expect(d.stats.favorites).toBe(1); expect(d.stats.due).toBe(1);
});

test('recovery key rewraps local key without exposing records or accepting wrong keys', async ({ page }) => {
  await start(page); await page.locator('.option').first().click(); await expect(page.locator('.answer-result')).toBeVisible();
  const owner = userId, code = recoveryCode;
  await page.evaluate(async ({ code }) => (await import('/src/vault.ts')).changeUnlock(code, 'recovered-local-passphrase', true), { code });
  await page.reload(); await unlock(page, 'recovered-local-passphrase');
  expect(Object.keys((await data(page)).states)).toHaveLength(1);
  const wrong = await page.evaluate(async ({ owner }) => {
    try { await (await import('/src/vault.ts')).unlockVault(owner, 'wrong-local-passphrase'); return false; } catch { return true; }
  }, { owner });
  expect(wrong).toBe(true);
});

test('IndexedDB v1 upgrade preserves encrypted records and adds rollback store', async ({ page }) => {
  await start(page); await page.locator('.option').first().click(); await expect(page.locator('.answer-result')).toBeVisible();
  await page.evaluate(async () => {
    const v = await import('/src/vault.ts'), db = await v.openDB();
    const rows = await new Promise<any[]>(resolve => { const r = db.transaction('vaults').objectStore('vaults').getAll(); r.onsuccess = () => resolve(r.result); });
    db.close();
    await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase('history-study-local'); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open('history-study-local', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('vaults', { keyPath: 'owner' });
      r.onsuccess = () => { const tx = r.result.transaction('vaults', 'readwrite'); rows.forEach(row => tx.objectStore('vaults').put(row)); tx.oncomplete = () => { r.result.close(); resolve(); }; };
      r.onerror = () => reject(r.error);
    });
  });
  await page.reload(); await unlock(page);
  expect(Object.keys((await data(page)).states)).toHaveLength(1);
  const stores = await page.evaluate(async () => Array.from((await (await import('/src/vault.ts')).openDB()).objectStoreNames));
  expect(stores).toContain('rollbacks');
});

test('storage unavailable is explicit and never falls back to plaintext', async ({ page, context }) => {
  const broken = await context.newPage();
  await broken.addInitScript(() => { indexedDB.open = () => { throw new DOMException('blocked', 'SecurityError'); }; });
  await broken.goto('/'); await expect(broken.getByRole('alert')).toContainText(/blocked|存储/);
  await expect(broken.locator('.brand')).toHaveCount(0);
  const localStorageText = await broken.evaluate(() => JSON.stringify(localStorage)); expect(localStorageText).not.toContain(PHRASE);
  await broken.close(); expect((await data(page)).owner).toBe(userId);
});

test('encrypted V1 SQLite export restores historical answer and note in new account', async ({ page }) => {
  const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  const result = JSON.parse(execFileSync(python, ['scripts/migration_fixture.py', path.resolve('.runtime/migration-e2e/' + randomUUID()), userId], { encoding: 'utf8' }));
  expect(result.source_unchanged).toBe(true);
  const backup = JSON.parse(readFileSync(result.path, 'utf8'));
  await page.evaluate(async backup => { const data = await (await import('/src/vault.ts')).decryptBackup(backup, 'isolated-migration-password'); await (await import('/src/learning.ts')).restoreData(data); }, backup);
  const restored = await data(page); expect(restored.states[result.qid].note).toBe('V1 synthetic migration note'); expect(restored.states[result.qid].favorite).toBe(true); expect(restored.sessions[result.session].results[result.qid].correct).toBe(true);
  await page.reload(); await unlock(page); expect((await data(page)).states[result.qid].first_correct).toBe(true);
  const next = await local(page, '/sessions', 'POST', { mode: 'category', question_id: result.qid });
  await local(page, '/sessions/' + next.id + '/answers', 'POST', { revision: next.revision, question_id: result.qid, selected: questions[result.qid].answer_ids });
  const again = await data(page); expect(again.states[result.qid].attempts).toBe(2);
  await page.evaluate(async () => (await import('/src/learning.ts')).validateData(await (await import('/src/vault.ts')).readData()));
});

test('browser process close and reopen retains encrypted data but requires unlock', async ({ browser }) => {
  const dir = path.resolve('.runtime/persistent-browser/' + randomUUID());
  let context = await browser.browserType().launchPersistentContext(dir, { headless: true, baseURL: 'http://127.0.0.1:5174' });
  let p = await context.newPage(); await login(p, username); await start(p); await p.locator('.option').first().click(); await expect(p.locator('.answer-result')).toBeVisible();
  await context.close();
  context = await browser.browserType().launchPersistentContext(dir, { headless: true, baseURL: 'http://127.0.0.1:5174' });
  p = await context.newPage(); await p.goto('/'); await expect(p.getByRole('heading', { name: '解锁本机学习记录' })).toBeVisible(); await unlock(p);
  expect(Object.keys((await data(p)).states)).toHaveLength(1); await context.close();
});

test('late AI response after logout cannot update the next account', async ({ page, request }) => {
  const b = await makeUser(request); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/ai/chat', async route => { await held; await route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"delta","text":"late-private-sentinel"}\n\ndata: {"type":"done"}\n\n' }).catch(() => undefined); });
  await start(page); await page.getByRole('button', { name: '问 AI', exact: true }).click(); await page.getByLabel('允许发送本题、当前选择和追问给服务器与 AI 供应商').check();
  await page.getByRole('button', { name: '讲解本题', exact: true }).click(); await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  await logout(page); await login(page, b.username); release();
  expect((await data(page)).chats).toEqual({}); await expect(page.getByText('late-private-sentinel')).toHaveCount(0);
});

test('backup UI exports encrypted file and previews before replacing', async ({ page }) => {
  await start(page); await page.locator('.option').first().click(); await expect(page.locator('.answer-result')).toBeVisible();
  await page.getByRole('button', { name: '设置与数据', exact: true }).first().click();
  await page.getByLabel('备份文件口令', { exact: true }).fill(BACKUP); await page.getByLabel('确认备份口令（导出时）').fill(BACKUP);
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: '导出加密学习记录', exact: true }).click();
  const downloaded = await download, content = readFileSync((await downloaded.path())!);
  expect(JSON.parse(content.toString()).format).toBe('history-study-encrypted-v2');
  await page.locator('input[type=file]').setInputFiles({ name: 'encrypted-backup.json', mimeType: 'application/json', buffer: content });
  await page.getByLabel('备份文件口令', { exact: true }).fill(BACKUP); await page.getByRole('button', { name: '校验并预览恢复', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('1 道已答题');
  await page.getByRole('button', { name: '确认恢复并保留原快照', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(Object.keys((await data(page)).states)).toHaveLength(1);
});

test('administrator UI creates accounts and invitations while ordinary users cannot manage them', async ({ page }) => {
  await page.getByRole('button', { name: '设置与数据', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '管理员控制台' })).toHaveCount(0);
  await logout(page); await login(page, 'e2e_admin');
  await page.getByRole('button', { name: '设置与数据', exact: true }).first().click();
  await page.getByText('创建账号', { exact: true }).click();
  const name = 'ui' + randomUUID().slice(0, 12);
  await page.getByLabel('新账号用户名', { exact: true }).fill(name);
  await page.getByLabel('新账号显示名称', { exact: true }).fill('UI 测试账号');
  await page.getByLabel('新账号登录密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '创建普通账号', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '管理操作已保存。' })).toBeVisible();
  await page.getByText('邀请码', { exact: true }).click();
  await page.getByRole('button', { name: '生成邀请码', exact: true }).click();
  const code = await page.locator('.admin-panel .recovery-box code').innerText();
  await page.getByText(/^管理账号（/).click();
  const row = page.locator('.admin-row').filter({ hasText: '@' + name });
  await row.getByRole('button', { name: '禁用', exact: true }).click();
  await expect(row.getByRole('button', { name: '启用', exact: true })).toBeEnabled();
  await row.getByRole('button', { name: '启用', exact: true }).click();
  await expect(row.getByRole('button', { name: '禁用', exact: true })).toBeEnabled();
  await logout(page); await page.getByRole('button', { name: '使用邀请码注册', exact: true }).click();
  const invited = 'iv' + randomUUID().slice(0, 12);
  await page.getByLabel('用户名', { exact: true }).fill(invited);
  await page.getByLabel('显示名称', { exact: true }).fill('受邀测试账号');
  await page.getByLabel('邀请码', { exact: true }).fill(code);
  await page.getByLabel('登录密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('账号创建成功');
  await login(page, invited);
  expect((await data(page)).states).toEqual({});
});

for (const width of [320, 360, 375, 390, 414, 768, 820, 1024, 1280, 1440]) {
  test(`responsive ${width}px, portrait/landscape, drawers, long content and keyboard focus`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1080 });
    const longest = [...bank.questions].sort((a: any, b: any) => (b.stem.length + b.options.reduce((n: number, o: any) => n + o.text.length, 0)) - (a.stem.length + a.options.reduce((n: number, o: any) => n + o.text.length, 0)))[0];
    await start(page, 'category', { question_id: longest.id });
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    expect(await overflow()).toBe(false);
    await page.getByRole('button', { name: '问 AI', exact: true }).click();
    await expect(page.getByRole('button', { name: '收起AI侧栏', exact: true })).toBeInViewport();
    await page.getByLabel('允许发送本题、当前选择和追问给服务器与 AI 供应商').check();
    await page.getByRole('button', { name: '讲解本题', exact: true }).click();
    await expect(page.locator('.ai-message.assistant h2')).toBeVisible();
    expect(await overflow()).toBe(false);
    if ([390, 820].includes(width)) await page.screenshot({ path: `artifacts/screenshots/v2/device-${width}-ai.png`, fullPage: true });
    if (width < 1024) { await page.keyboard.press('Escape'); await expect(page.locator('.ai-sidebar')).toHaveCount(0); }
    else await page.getByRole('button', { name: '收起AI侧栏', exact: true }).click();
    await page.setViewportSize({ width: Math.max(width, 844), height: Math.min(width, 820) });
    expect(await overflow()).toBe(false);
    await page.getByRole('button', { name: '问 AI', exact: true }).click();
    await page.getByLabel('向AI追问').fill('长追问：' + '这道题的历史背景是什么？'.repeat(20));
    await expect(page.getByRole('button', { name: '发送追问', exact: true })).toBeInViewport();
    expect(await overflow()).toBe(false);
  });
}
