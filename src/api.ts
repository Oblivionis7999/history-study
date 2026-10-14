export type Kind = 'single' | 'multiple' | 'judge';
export type Mode = 'full' | 'paper80' | 'paper20' | 'category' | 'review' | 'favorites';
export type Feedback = 'immediate' | 'test';
export interface Question { id: string; type: Kind; stem: string; theme: string; shuffle_safe: boolean; source_number: number; options: { id: string; text: string }[] }
export interface Result { selected: string[]; correct_ids: string[]; correct: boolean; answered_at: number }
export interface Session { id: string; mode: Mode; title: string; feedback: Feedback; status: 'active' | 'completed'; question_ids: string[]; questions: Question[]; cursor: number; drafts: Record<string, string[]>; results: Record<string, Result>; revision: number; created_at: number; updated_at: number }
export interface SessionSummary { id: string; mode: Mode; title: string; feedback: Feedback; status: string; cursor: number; total: number; answered: number; correct: number; updated_at: number }
export interface QuestionState { id: string; favorite: boolean; uncertain: boolean; wrong: boolean; mastered: boolean; disputed: boolean; note: string; revision: number; first_correct?: boolean }
export interface Preferences { auto_next: boolean; shuffle_options: boolean; reduce_repeats: boolean }
export interface Dashboard { title: string; total: number; version: string; counts: Record<Kind, number>; stats: { answered: number; first_correct: number; due: number; wrong: number; uncertain: number; favorites: number; mastered: number }; themes: { id: string; name: string; subtitle: string; total: number; done: number; due: number }[]; states: Record<string, QuestionState>; sessions: SessionSummary[]; prefs: Preferences; ai: { configured: boolean; model: string } }
export interface Message { role: 'user' | 'assistant'; text: string; time?: number; options?: { id: string; label: string; text: string }[] }
export class ApiError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status } }
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch('/api' + path, { method, credentials: 'same-origin', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({ detail: '服务器响应异常，请稍后重试。' }));
  if (!r.ok) throw new ApiError(r.status, typeof data.detail === 'string' ? data.detail : '请求未通过校验，请重新尝试。');
  return data as T;
}
export const labels: Record<Kind, string> = { single: '单选题', multiple: '多选题', judge: '判断题' };
export const modeNames: Record<Mode, string> = { full: '通刷模式', paper80: '80题随机卷', paper20: '20题小卷', category: '分类练习', review: '错题与不确定', favorites: '收藏练习' };
export function initialState(id: string): QuestionState { return { id, favorite: false, uncertain: false, wrong: false, mastered: false, disputed: false, note: '', revision: 0 } }
