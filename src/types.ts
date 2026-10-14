export type Kind = 'single' | 'multiple' | 'judge';
export type Mode = 'full' | 'paper80' | 'paper20' | 'category' | 'review' | 'favorites';
export type Feedback = 'immediate' | 'test';
export interface Question { id: string; type: Kind; stem: string; theme: string; shuffle_safe: boolean; source_number: number; options: { id: string; text: string }[] }
export interface Result { selected: string[]; correct_ids: string[]; correct: boolean; answered_at: number }
export interface Session { id: string; mode: Mode; title: string; feedback: Feedback; status: 'active' | 'completed'; question_ids: string[]; questions: Question[]; cursor: number; drafts: Record<string, string[]>; results: Record<string, Result>; revision: number; created_at: number; updated_at: number }
export interface SessionSummary { id: string; mode: Mode; title: string; feedback: Feedback; status: string; cursor: number; total: number; answered: number; correct: number; updated_at: number }
export interface QuestionState { id: string; favorite: boolean; uncertain: boolean; wrong: boolean; mastered: boolean; disputed: boolean; note: string; revision: number; first_correct?: boolean; last_answered?: number; last_wrong?: number; attempts?: number; wrong_count?: number; streak?: number; due_at?: number }
export interface Preferences { auto_next: boolean; shuffle_options: boolean; reduce_repeats: boolean; ai_consent?: boolean }
export interface Dashboard { title: string; total: number; version: string; counts: Record<Kind, number>; stats: { answered: number; first_correct: number; due: number; wrong: number; uncertain: number; favorites: number; mastered: number }; themes: { id: string; name: string; subtitle: string; total: number; done: number; due: number }[]; states: Record<string, QuestionState>; sessions: SessionSummary[]; prefs: Preferences; ai: { configured: boolean; model: string } }
export interface Message { role: 'user' | 'assistant'; text: string; time?: number; options?: { id: string; label: string; text: string }[] }
export class ApiError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status } }
export const labels: Record<Kind, string> = { single: '单选题', multiple: '多选题', judge: '判断题' };
export const modeNames: Record<Mode, string> = { full: '通刷模式', paper80: '80题随机卷', paper20: '20题小卷', category: '分类练习', review: '错题与不确定', favorites: '收藏练习' };
export function initialState(id: string): QuestionState { return { id, favorite: false, uncertain: false, wrong: false, mastered: false, disputed: false, note: '', revision: 0 } }
export interface User { id: string; username: string; display_name: string; role: 'admin' | 'user'; disabled: number; created_at: number }
export interface Bank { title: string; version: string; themes: { id: string; name: string; subtitle: string }[]; questions: (Question & { answer_ids: string[] })[] }
export interface AIConfig { configured: boolean; model: string; cache_scope: string; daily_limit: number; used_today: number }
export type StoredSession = Omit<Session, 'questions'> & { bank_version: string; option_orders: Record<string, string[]> };
export interface LearningData { schema: 2; owner: string; bank_version: string; sessions: Record<string, StoredSession>; states: Record<string, QuestionState>; prefs: Preferences; chats: Record<string, Message[]>; cache: Record<string, { text: string; options: Message['options'] }>; pending: Record<string, unknown>; noteDrafts: Record<string, string>; lastBackup: number; dailyTarget: number }
