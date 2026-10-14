import type { LearningData } from './types';

type Cipher = { iv: string; data: string };
type Vault = { owner: string; version: 2; salt: string; wrapped: Cipher; recovery: Cipher; payload: Cipher; revision: number };
const ITERATIONS = 600000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let owner = '', key: CryptoKey | null = null, epoch = 0;
let queue: Promise<unknown> = Promise.resolve();
let connection: Promise<IDBDatabase> | null = null;
export const activeOwner = () => owner;
export const activeEpoch = () => epoch;
export function assertActive(id: string, generation: number) {
  if (!key || id !== owner || generation !== epoch) throw new Error('学习空间已锁定或账号已切换。');
}
export function lockVault() { key = null; owner = ''; epoch++; queue = Promise.resolve(); }
export function bytes(size: number) { return crypto.getRandomValues(new Uint8Array(size)); }
export function base64(data: Uint8Array | ArrayBuffer) {
  let binary = ''; for (const n of new Uint8Array(data)) binary += String.fromCharCode(n);
  return btoa(binary);
}
function unbase64(value: string) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
async function aes(raw: Uint8Array) { return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function derive(password: string, salt: string) {
  const source = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unbase64(salt), iterations: ITERATIONS, hash: 'SHA-256' }, source, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(k: CryptoKey, data: Uint8Array, aad: string): Promise<Cipher> {
  const iv = bytes(12);
  const result = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad), tagLength: 128 }, k, data as BufferSource);
  return { iv: base64(iv), data: base64(result) };
}
async function unseal(k: CryptoKey, cipher: Cipher, aad: string) {
  if (!cipher || typeof cipher.iv !== 'string' || typeof cipher.data !== 'string' || unbase64(cipher.iv).length !== 12) throw new Error('密文格式无效。');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(cipher.iv), additionalData: encoder.encode(aad), tagLength: 128 }, k, unbase64(cipher.data)));
}
function storageError(e: unknown): Error {
  if (e instanceof DOMException && e.name === 'QuotaExceededError') return new Error('本机存储空间不足，保存未完成。请先导出记录，再清理空间。');
  if (e instanceof DOMException && ['InvalidStateError', 'SecurityError', 'UnknownError', 'VersionError'].includes(e.name)) return new Error('浏览器本地存储不可用。请退出隐私模式，允许网站存储后重试。');
  return e instanceof Error ? e : new Error('本机保存失败，原记录未修改。');
}
export function openDB(): Promise<IDBDatabase> {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    const request = indexedDB.open('history-study-local', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('vaults')) db.createObjectStore('vaults', { keyPath: 'owner' });
      if (!db.objectStoreNames.contains('rollbacks')) db.createObjectStore('rollbacks', { keyPath: 'owner' });
    };
    request.onerror = () => { connection = null; reject(storageError(request.error)); };
    request.onblocked = () => { connection = null; reject(new Error('请关闭此网站的其他标签页后重试数据库升级。')); };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); connection = null; }; resolve(request.result); };
  });
  return connection;
}
async function readRow(id: string, store = 'vaults'): Promise<Vault | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly'); const request = tx.objectStore(store).get(id);
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(storageError(tx.error));
  });
}
async function writeRow(row: Vault, expected: number | undefined, preserve = false, generation?: number): Promise<void> {
  const db = await openDB();
  if (generation !== undefined) assertActive(row.owner, generation);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['vaults', 'rollbacks'], 'readwrite');
    let conflict = false;
    let failure: unknown;
    const store = tx.objectStore('vaults'); const get = store.get(row.owner);
    get.onsuccess = () => {
      const existing = get.result as Vault | undefined;
      if (existing?.revision !== expected) { conflict = true; tx.abort(); return; }
      try {
        if (preserve && existing) tx.objectStore('rollbacks').put(existing);
        store.put(row);
      } catch (e) { failure = e; tx.abort(); }
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(conflict ? new Error('另一标签页已更新数据，请重新加载后重试；本次内容仍可重试。') : storageError(failure ?? tx.error));
  });
}
export async function hasVault(id: string) { return !!await readRow(id); }
function passphrase(value: string) { if (value.length < 12 || value.length > 256) throw new Error('本机解锁或备份口令需要 12–256 个字符。'); }
export async function createVault(id: string, password: string, data: LearningData) {
  const generation = epoch;
  passphrase(password);
  if (!crypto.subtle) throw new Error('本机加密需要 HTTPS 或 localhost 安全连接。');
  const salt = base64(bytes(16)), raw = bytes(32), recoveryBytes = bytes(32);
  const dataKey = await aes(raw);
  const row: Vault = { owner: id, version: 2, salt, revision: 1,
    wrapped: await seal(await derive(password, salt), raw, id + ':key'),
    recovery: await seal(await aes(recoveryBytes), raw, id + ':recovery'),
    payload: await seal(dataKey, encoder.encode(JSON.stringify(data)), id + ':data') };
  if (epoch !== generation) throw new Error('账号已切换，请重新建立空间。');
  await writeRow(row, undefined);
  if (epoch !== generation) throw new Error('账号已切换，新建空间已保存，请重新解锁。');
  raw.fill(0); lockVault(); owner = id; key = dataKey;
  const code = base64(recoveryBytes); recoveryBytes.fill(0); return code;
}
export async function unlockVault(id: string, password: string, recovery = false) {
  const generation = epoch;
  const row = await readRow(id);
  if (!row || row.version !== 2) throw new Error('本机记录不存在或加密版本不受支持。');
  let raw: Uint8Array;
  try { raw = await unseal(recovery ? await aes(unbase64(password.trim())) : await derive(password, row.salt), recovery ? row.recovery : row.wrapped, id + (recovery ? ':recovery' : ':key')); }
  catch { throw new Error('解锁口令或恢复密钥不正确，原记录未修改。'); }
  const dataKey = await aes(raw); raw.fill(0);
  await unseal(dataKey, row.payload, id + ':data');
  if (generation !== epoch) throw new Error('账号已切换，请重新解锁。');
  owner = id; key = dataKey;
}
export async function readData(): Promise<LearningData> {
  const id = owner, generation = epoch, currentKey = key;
  assertActive(id, generation);
  const row = await readRow(id);
  if (!row) throw new Error('本机数据已被清除，请使用备份恢复。');
  const data = upgrade(JSON.parse(decoder.decode(await unseal(currentKey!, row.payload, id + ':data'))));
  assertActive(id, generation);
  if (data.owner !== id) throw new Error('数据所属账号不匹配。');
  return data as LearningData;
}
function upgrade(data: any): LearningData {
  if (data.schema === 1) { data.schema = 2; data.dailyTarget ??= 20; data.noteDrafts ??= {}; data.pending ??= {}; }
  if (data.schema !== 2) throw new Error('本地数据版本较新，请更新网站。');
  return data;
}
export function transact<T>(change: (data: LearningData) => T, preserve = false): Promise<T> {
  const id = owner, generation = epoch, currentKey = key;
  const operation = async () => {
    assertActive(id, generation);
    const row = await readRow(id); if (!row) throw new Error('本机数据不存在。');
    const data = upgrade(JSON.parse(decoder.decode(await unseal(currentKey!, row.payload, id + ':data'))));
    const result = change(data);
    const payload = await seal(currentKey!, encoder.encode(JSON.stringify(data)), id + ':data');
    assertActive(id, generation);
    await writeRow({ ...row, revision: row.revision + 1, payload }, row.revision, preserve, generation);
    assertActive(id, generation); return result;
  };
  const promise = queue.catch(() => undefined).then(operation);
  queue = promise; return promise.catch(e => { throw storageError(e); });
}
export async function changeUnlock(old: string, next: string, recovery = false) {
  passphrase(next);
  const id = owner, generation = epoch;
  assertActive(id, generation);
  const row = (await readRow(id))!;
  let raw: Uint8Array;
  try { raw = await unseal(recovery ? await aes(unbase64(old.trim())) : await derive(old, row.salt), recovery ? row.recovery : row.wrapped, id + (recovery ? ':recovery' : ':key')); }
  catch { throw new Error('原解锁口令或恢复密钥不正确。'); }
  const salt = base64(bytes(16)); const wrapped = await seal(await derive(next, salt), raw, id + ':key'); raw.fill(0);
  await writeRow({ ...row, salt, wrapped, revision: row.revision + 1 }, row.revision, false, generation);
}
export async function restorePrevious() {
  const id = owner, generation = epoch;
  assertActive(id, generation);
  const previous = await readRow(id, 'rollbacks'), current = await readRow(id);
  if (!previous || !current) throw new Error('没有恢复前的本机快照。');
  // The same data key survives passphrase changes; keep current wrapping material.
  await unseal(key!, previous.payload, id + ':data');
  await writeRow({ ...current, payload: previous.payload, revision: current.revision + 1 }, current.revision, true, generation);
}
export async function deleteLocal() {
  const id = owner, generation = epoch, db = await openDB(); assertActive(id, generation);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['vaults', 'rollbacks'], 'readwrite');
    tx.objectStore('vaults').delete(id); tx.objectStore('rollbacks').delete(id);
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(storageError(tx.error));
  });
  lockVault();
}
export async function encryptBackup(data: LearningData, password: string) {
  passphrase(password);
  const header = { format: 'history-study-encrypted-v2', owner: data.owner, bank_version: data.bank_version, exported_at: Date.now(), kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: base64(bytes(16)) };
  const payload = await seal(await derive(password, header.salt), encoder.encode(JSON.stringify(data)), JSON.stringify(header));
  return { ...header, payload };
}
export async function decryptBackup(value: unknown, password: string): Promise<LearningData> {
  if (!value || typeof value !== 'object') throw new Error('备份不是有效对象。');
  const b = value as Awaited<ReturnType<typeof encryptBackup>>;
  if (b.format !== 'history-study-encrypted-v2' || b.kdf !== 'PBKDF2-SHA256' || b.iterations !== ITERATIONS || typeof b.owner !== 'string' || typeof b.salt !== 'string' || unbase64(b.salt).length !== 16) throw new Error('备份格式或加密参数不受支持。');
  const header = { format: b.format, owner: b.owner, bank_version: b.bank_version, exported_at: b.exported_at, kdf: b.kdf, iterations: b.iterations, salt: b.salt };
  let data;
  try { data = JSON.parse(decoder.decode(await unseal(await derive(password, b.salt), b.payload, JSON.stringify(header)))); }
  catch { throw new Error('备份口令不正确或文件已损坏；原数据未修改。'); }
  if (data.owner !== header.owner || data.bank_version !== header.bank_version) throw new Error('备份头部与记录不匹配。');
  return data;
}
