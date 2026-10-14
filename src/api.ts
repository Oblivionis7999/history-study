import { ApiError } from './types';
import { localRequest } from './learning';
import { activeOwner } from './vault';
export * from './types';
export async function remote<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch('/api' + path, { method, credentials: 'same-origin', headers: { 'X-Study-Request': '1', ...(activeOwner() ? { 'X-Study-User': activeOwner() } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({ detail: '服务器响应异常，请稍后重试。' }));
  if (!r.ok) { if (r.status === 401) window.dispatchEvent(new Event('study-auth-expired')); throw new ApiError(r.status, typeof data.detail === 'string' ? data.detail : '请求未通过校验，请重试。'); }
  return data as T;
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  return localRequest(path, method, body) as Promise<T>;
}
