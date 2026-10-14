import { ApiError, initialState, modeNames } from './types';
import type { AIConfig, Bank, Dashboard, LearningData, Message, QuestionState, Result, Session, StoredSession } from './types';
import { activeEpoch, activeOwner, assertActive, readData, transact } from './vault';

let bank: Bank;
let questions: Record<string, Bank['questions'][number]> = {};
let ai: AIConfig = { configured: false, model: '', cache_scope: '', daily_limit: 0, used_today: 0 };
export function configureLearning(value: Bank, config: AIConfig) {
  bank = value; questions = Object.fromEntries(value.questions.map(q => [q.id, q])); ai = config;
}
export const currentBank = () => bank;
export const aiConfig = () => ai;
const now = () => Date.now() / 1000;
const clone = <T,>(value: T): T => structuredClone(value);
export function emptyData(owner: string): LearningData {
  return { schema: 2, owner, bank_version: bank.version, sessions: {}, states: {}, prefs: { auto_next: false, shuffle_options: false, reduce_repeats: false }, chats: {}, cache: {}, pending: {}, noteDrafts: {}, lastBackup: 0, dailyTarget: 20 };
}
function shuffled<T>(items: T[]) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}
function selected(qid: string, value: unknown, all = false): asserts value is string[] {
  if (!questions[qid] || !Array.isArray(value) || value.some(v => typeof v !== 'string' || !questions[qid].options.some(o => o.id === v)) || new Set(value).size !== value.length || (!all && questions[qid].type !== 'multiple' && value.length > 1)) throw new Error('备份中的选项无效。');
}
function grade(qid: string, selected: string[]): Result {
  const correct = questions[qid].answer_ids;
  return { selected: [...selected], correct_ids: [...correct], correct: selected.length === correct.length && selected.every(o => correct.includes(o)), answered_at: now() };
}
function record(data: LearningData, qid: string, result: Result) {
  const s = data.states[qid] ?? initialState(qid);
  if (s.attempts === undefined) {
    const previous = Object.values(data.sessions).map(session => session.results[qid]).filter(r => r && r !== result).sort((a, b) => a.answered_at - b.answered_at);
    s.attempts = previous.length; s.wrong_count = previous.filter(r => !r.correct).length;
    s.streak = 0; for (const r of previous) s.streak = r.correct ? s.streak + 1 : 0;
  }
  s.first_correct ??= result.correct;
  s.last_answered = result.answered_at; s.attempts = (s.attempts ?? 0) + 1;
  s.streak = result.correct ? (s.streak ?? 0) + 1 : 0;
  if (!result.correct) { s.wrong = true; s.mastered = false; s.wrong_count = (s.wrong_count ?? 0) + 1; s.last_wrong = result.answered_at; }
  s.due_at = result.answered_at + (result.correct ? [1, 3, 7, 14, 30][Math.min(s.streak - 1, 4)] : 0) * 86400;
  s.revision++; data.states[qid] = s;
}
function checkRevision(item: { revision: number }, revision: unknown) {
  if (item.revision !== revision) throw new ApiError(409, '这份记录已在其他标签页更新，请加载最新记录后重试。');
}
function hydrate(s: StoredSession): Session {
  return { ...clone(s), questions: s.question_ids.map(id => {
    const { answer_ids: _answer, ...q } = questions[id];
    return { ...q, options: s.option_orders[id].map(oid => q.options.find(o => o.id === oid)!) };
  }) };
}
export function due(s: QuestionState) { return !s.mastered && (s.wrong || s.uncertain || (s.due_at !== undefined && s.due_at <= now())); }
export function reviewReason(s: QuestionState) {
  if (s.uncertain) return '标记不确定，优先复习';
  if (s.wrong) return `累计答错 ${s.wrong_count ?? 1} 次`;
  return s.due_at && s.due_at <= now() ? '已到复习时间' : s.mastered ? '已确认掌握' : '尚未到复习时间';
}
export function dashboard(data: LearningData): Dashboard {
  const states = Object.values(data.states), answered = states.filter(s => s.first_correct !== undefined);
  return { title: bank.title, total: 700, version: bank.version, counts: { single: 300, multiple: 300, judge: 100 }, states: clone(data.states), prefs: clone(data.prefs), ai,
    stats: { answered: answered.length, first_correct: answered.filter(s => s.first_correct).length, due: states.filter(due).length, wrong: states.filter(s => s.wrong).length, uncertain: states.filter(s => s.uncertain).length, favorites: states.filter(s => s.favorite).length, mastered: states.filter(s => s.mastered).length },
    themes: bank.themes.map(t => { const ids = bank.questions.filter(q => q.theme === t.id).map(q => q.id); return { ...t, total: ids.length, done: ids.filter(id => data.states[id]?.first_correct !== undefined).length, due: ids.filter(id => data.states[id] && due(data.states[id])).length }; }),
    sessions: Object.values(data.sessions).sort((a, b) => b.updated_at - a.updated_at).map(s => ({ id: s.id, mode: s.mode, title: s.title, feedback: s.feedback, status: s.status, cursor: s.cursor, total: s.question_ids.length, answered: s.feedback === 'test' && s.status === 'active' ? Object.values(s.drafts).filter(v => v.length).length : Object.keys(s.results).length, correct: Object.values(s.results).filter(r => r.correct).length, updated_at: s.updated_at })) };
}
type Params = Record<string, any>;
function newSession(data: LearningData, body: Params): Session {
  if (!Object.hasOwn(modeNames, body.mode)) throw new Error('练习模式无效。');
  const mode = body.mode as StoredSession['mode'], feedback = body.feedback ?? 'immediate';
  if (!['immediate', 'test'].includes(feedback) || (feedback === 'test' && !['paper20', 'paper80'].includes(mode))) throw new Error('自测模式无效。');
  let pool = [...bank.questions];
  if (body.theme) pool = pool.filter(q => q.theme === body.theme);
  if (body.type) pool = pool.filter(q => q.type === body.type);
  if (body.question_id) pool = pool.filter(q => q.id === body.question_id);
  if (body.query) { const query = String(body.query).trim().toLowerCase(); pool = pool.filter(q => (q.id + ' ' + q.source_number + ' ' + q.stem + ' ' + q.options.map(o => o.text).join(' ')).toLowerCase().includes(query)); }
  if (mode === 'review' || mode === 'favorites' || body.state_filter) {
    const filter = mode === 'favorites' ? 'favorite' : body.state_filter ?? body.review_filter ?? 'all';
    pool = pool.filter(q => {
      const s = data.states[q.id]; if (!s) return false;
      return filter === 'all' || filter === 'due' ? due(s) : filter === 'frequent' ? (s.wrong_count ?? 0) >= 2 : filter === 'recent' ? s.wrong : Boolean(s[filter as keyof QuestionState]);
    });
    pool.sort((a, b) => {
      const sa = data.states[a.id], sb = data.states[b.id];
      if (body.review_sort === 'recent' || filter === 'recent') return (sb.last_wrong ?? sb.last_answered ?? 0) - (sa.last_wrong ?? sa.last_answered ?? 0);
      if (body.review_sort === 'frequent' || filter === 'frequent') return (sb.wrong_count ?? 0) - (sa.wrong_count ?? 0);
      return Number(sb.uncertain) - Number(sa.uncertain) || Number(sb.wrong) - Number(sa.wrong) || (sa.due_at ?? 0) - (sb.due_at ?? 0);
    });
  }
  if (mode === 'full') pool = [...bank.questions].sort((a, b) => bank.themes.findIndex(t => t.id === a.theme) - bank.themes.findIndex(t => t.id === b.theme));
  if (mode === 'paper20' || mode === 'paper80') {
    pool = [];
    const quota = mode === 'paper80' ? [35, 35, 10] : [9, 9, 2];
    (['single', 'multiple', 'judge'] as const).forEach((type, i) => {
      let options = shuffled(bank.questions.filter(q => q.type === type));
      if (body.reduce_repeats) options.sort((a, b) => (data.states[a.id]?.last_answered ?? 0) - (data.states[b.id]?.last_answered ?? 0));
      pool.push(...options.slice(0, quota[i]));
    });
    pool = shuffled(pool);
  } else if (body.random_order && mode !== 'full') pool = shuffled(pool);
  if (!pool.length) throw new Error('此筛选下暂无题目，请调整范围。');
  const id = crypto.randomUUID();
  const s: StoredSession = { id, bank_version: bank.version, mode, title: modeNames[mode], feedback, status: 'active', question_ids: pool.map(q => q.id), option_orders: Object.fromEntries(pool.map(q => [q.id, body.shuffle_options && q.shuffle_safe && q.type !== 'judge' ? shuffled(q.options.map(o => o.id)) : q.options.map(o => o.id)])), drafts: {}, results: {}, cursor: 0, revision: 1, created_at: now(), updated_at: now() };
  data.sessions[id] = s; return hydrate(s);
}
export async function localRequest(path: string, method: string, body?: unknown): Promise<unknown> {
  const [route, query = ''] = path.split('?'); const params = new URLSearchParams(query);
  if (method === 'GET') {
    const data = await readData();
    if (route === '/dashboard') return dashboard(data);
    if (route.startsWith('/ai/history/')) return { messages: clone(data.chats[route.slice(12) + ':' + (params.get('channel') ?? 'solution')] ?? []) };
    const match = route.match(/^\/sessions\/([^/]+)$/);
    if (match && data.sessions[match[1]]) return hydrate(data.sessions[match[1]]);
    throw new ApiError(404, '本机没有此记录。');
  }
  return transact(data => {
    if (data.bank_version !== bank.version) throw new Error('题库版本不匹配，请先导出备份并更新。');
    const b = (body ?? {}) as Params;
    if (route === '/sessions') return newSession(data, b);
    if (route === '/preferences') {
      for (const key of ['auto_next', 'shuffle_options', 'reduce_repeats'] as const) if (typeof b[key] === 'boolean') data.prefs[key] = b[key];
      return clone(data.prefs);
    }
    const qm = route.match(/^\/questions\/([^/]+)\/state$/);
    if (qm && questions[qm[1]]) {
      const state = data.states[qm[1]] ?? initialState(qm[1]); checkRevision(state, b.revision);
      for (const key of ['favorite', 'uncertain', 'mastered', 'disputed'] as const) if (typeof b[key] === 'boolean') state[key] = b[key];
      if (typeof b.note === 'string') { if (b.note.length > 12000) throw new Error('笔记不能超过12000字。'); state.note = b.note; delete data.noteDrafts[qm[1]]; }
      if (b.mastered === true) { state.wrong = false; state.uncertain = false; }
      if (b.uncertain === true) { state.mastered = false; state.due_at = now(); }
      state.revision++; data.states[qm[1]] = state; return clone(state);
    }
    const sm = route.match(/^\/sessions\/([^/]+)\/(progress|answers|finish)$/);
    if (!sm || !data.sessions[sm[1]]) throw new ApiError(404, '练习不存在。');
    const s = data.sessions[sm[1]], action = sm[2], qid = b.question_id;
    if (action === 'answers' && s.results[qid]) return hydrate(s);
    if (action === 'finish' && s.status === 'completed') return hydrate(s);
    checkRevision(s, b.revision);
    if (qid) {
      if (!s.question_ids.includes(qid)) throw new Error('题目不在当前练习中。');
      selected(qid, b.selected);
      if (action === 'answers' && !b.selected.length) throw new Error('请先选择答案。');
      if (s.status === 'active' && !s.results[qid]) {
        s.drafts[qid] = [...b.selected];
        if (action === 'answers' && s.feedback === 'immediate') { const r = grade(qid, b.selected); s.results[qid] = r; record(data, qid, r); }
      }
    }
    if (b.cursor !== undefined) {
      if (!Number.isInteger(b.cursor) || b.cursor < 0 || b.cursor >= s.question_ids.length) throw new Error('题号超出范围。');
      s.cursor = b.cursor;
    }
    if (action === 'finish') {
      if (s.feedback === 'test') {
        for (const [qid, value] of Object.entries(s.drafts)) if (value.length) { const r = grade(qid, value); s.results[qid] = r; record(data, qid, r); }
        s.status = 'completed';
      } else if (Object.keys(s.results).length !== s.question_ids.length) throw new Error('请先完成题目；可以随时离开并续做。');
    }
    if (Object.keys(s.results).length === s.question_ids.length) s.status = 'completed';
    s.revision++; s.updated_at = now(); delete data.pending[s.id + ':' + (qid ?? 'cursor')]; return hydrate(s);
  });
}
export async function savePending(sid: string, qid: string, ticket: unknown) { await transact(data => { data.pending[sid + ':' + qid] = ticket; }); }
export async function saveNoteDraft(qid: string, value: string) { await transact(data => { if (value.length > 12000) throw new Error('笔记过长。'); data.noteDrafts[qid] = value; }); }
export async function getDrafts(sid: string, qid: string) { const data = await readData(); return { pending: data.pending[sid + ':' + qid] as { body: { selected?: string[] } } | undefined, note: data.noteDrafts[qid] }; }

export function validateData(value: unknown): asserts value is LearningData {
  const fail = () => { throw new Error('备份完整性校验失败，原数据未修改。'); };
  const object = (v: unknown): v is Params => !!v && typeof v === 'object' && !Array.isArray(v);
  const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!object(value) || value.schema !== 2 || value.owner !== activeOwner()) throw new Error('备份所属账号不匹配，请登录文件所属账号；未导入。');
  if (value.bank_version !== bank.version) throw new Error('备份题库版本不匹配，原数据未修改。');
  for (const field of ['sessions', 'states', 'prefs', 'chats', 'cache', 'pending', 'noteDrafts']) if (!object(value[field])) fail();
  if (!number(value.lastBackup) || !Number.isInteger(value.dailyTarget) || value.dailyTarget < 1 || value.dailyTarget > 700) fail();
  for (const flag of ['auto_next', 'shuffle_options', 'reduce_repeats']) if (typeof value.prefs[flag] !== 'boolean') fail();
  for (const [qid, s] of Object.entries(value.states) as [string, Params][]) {
    if (!questions[qid] || !object(s) || s.id !== qid || typeof s.note !== 'string' || s.note.length > 12000 || !number(s.revision)) fail();
    for (const flag of ['favorite', 'uncertain', 'wrong', 'mastered', 'disputed']) if (typeof s[flag] !== 'boolean') fail();
    if (s.first_correct !== undefined && typeof s.first_correct !== 'boolean') fail();
    for (const field of ['attempts', 'wrong_count', 'streak', 'last_answered', 'last_wrong', 'due_at']) if (s[field] !== undefined && !number(s[field])) fail();
  }
  for (const [sid, s] of Object.entries(value.sessions) as [string, Params][]) {
    if (!/^[\w-]{1,100}$/.test(sid) || !object(s) || s.id !== sid || !Object.hasOwn(modeNames, s.mode) || !['immediate', 'test'].includes(s.feedback) || !['active', 'completed'].includes(s.status) || typeof s.title !== 'string' || !number(s.created_at) || !number(s.updated_at) || !number(s.revision) || s.bank_version !== bank.version) fail();
    const ids = s.question_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 700 || ids.some(id => !questions[id]) || new Set(ids).size !== ids.length || !Number.isInteger(s.cursor) || s.cursor < 0 || s.cursor >= ids.length || !object(s.option_orders) || !object(s.drafts) || !object(s.results)) fail();
    if (s.feedback === 'test' && !['paper20', 'paper80'].includes(s.mode)) fail();
    if (Object.keys(s.option_orders).length !== ids.length) fail();
    for (const qid of ids) { selected(qid, s.option_orders[qid], true); if (s.option_orders[qid].length !== questions[qid].options.length || ((!questions[qid].shuffle_safe || questions[qid].type === 'judge') && JSON.stringify(s.option_orders[qid]) !== JSON.stringify(questions[qid].options.map(o => o.id)))) fail(); }
    for (const [qid, v] of Object.entries(s.drafts)) { if (!ids.includes(qid)) fail(); selected(qid, v); }
    for (const [qid, r] of Object.entries(s.results) as [string, Params][]) {
      if (!ids.includes(qid) || !object(r)) fail(); selected(qid, r.selected);
      const expected = grade(qid, r.selected);
      if (!r.selected.length || r.correct !== expected.correct || JSON.stringify(r.correct_ids) !== JSON.stringify(expected.correct_ids) || !number(r.answered_at) || JSON.stringify(r.selected) !== JSON.stringify(s.drafts[qid])) fail();
    }
    if (s.feedback === 'test' && s.status === 'active' && Object.keys(s.results).length) fail();
    if (s.status === 'completed' && Object.keys(s.results).length !== (s.feedback === 'immediate' ? ids.length : Object.values(s.drafts).filter((v: any) => v.length).length)) fail();
  }
  for (const [cid, messages] of Object.entries(value.chats)) {
    const [qid, channel] = cid.split(':');
    if (!questions[qid] || !['solution', 'hint'].includes(channel) || !Array.isArray(messages) || messages.some(m => !object(m) || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string' || m.text.length > 30000 || (m.options && (!Array.isArray(m.options) || m.options.length !== questions[qid].options.length || m.options.some((o: any) => !object(o) || typeof o.label !== 'string' || !questions[qid].options.some(original => original.id === o.id && original.text === o.text)))))) fail();
  }
  for (const [qid, note] of Object.entries(value.noteDrafts)) if (!questions[qid] || typeof note !== 'string' || note.length > 12000) fail();
  for (const [id, entry] of Object.entries(value.cache)) if (!/^[a-f0-9]{64}$/.test(id) || !object(entry) || typeof entry.text !== 'string' || entry.text.length > 30000) fail();
  const history: Record<string, Result[]> = {};
  for (const session of Object.values(value.sessions) as StoredSession[]) for (const [qid, result] of Object.entries(session.results)) (history[qid] ??= []).push(result);
  for (const [qid, results] of Object.entries(history)) {
    const state = value.states[qid]; results.sort((a, b) => a.answered_at - b.answered_at);
    // Two answers may share a millisecond; do not invent their ordering on import.
    if (!state || !results.some(r => r.answered_at === results[0].answered_at && r.correct === state.first_correct) || (state.attempts !== undefined && state.attempts !== results.length) || (state.wrong_count !== undefined && state.wrong_count !== results.filter(r => !r.correct).length)) fail();
  }
  for (const [qid, state] of Object.entries(value.states) as [string, Params][]) if (!history[qid] && (state.first_correct !== undefined || state.attempts || state.wrong_count)) fail();
  // Pending writes are never replayed automatically; only valid session/selection drafts may be restored.
  for (const [id, pending] of Object.entries(value.pending) as [string, Params][]) {
    const [sid, qid] = id.split(':'); if (!value.sessions[sid] || !object(pending) || pending.sid !== sid || !object(pending.body) || !['/progress', '/answers', '/finish'].includes(pending.path)) fail();
    if (qid !== 'cursor') { if (!value.sessions[sid].question_ids.includes(qid)) fail(); selected(qid, pending.body.selected); }
  }
}
export async function restoreData(value: unknown) {
  validateData(value);
  const incoming = clone(value);
  await transact(data => { for (const key of Object.keys(data)) delete (data as unknown as Params)[key]; Object.assign(data, incoming); }, true);
}
export function fromLegacy(value: any): LearningData {
  if (!value || value.format !== 'history-study-migration-v2' || value.owner !== activeOwner() || value.bank_version !== bank.version) throw new Error('旧版导出归属或题库版本不匹配，请用迁移工具明确指定当前用户 ID。');
  const records = value.records;
  if (!records || !['session', 'state', 'prefs', 'chat', 'cache'].every(k => Array.isArray(records[k]))) throw new Error('旧版备份无效。');
  const data = emptyData(value.owner);
  data.sessions = Object.fromEntries(records.session.map((s: StoredSession) => [s.id, s]));
  data.states = Object.fromEntries(records.state.map((s: QuestionState) => [s.id, s]));
  if (records.prefs[0]) for (const k of ['auto_next', 'shuffle_options', 'reduce_repeats'] as const) data.prefs[k] = records.prefs[0][k];
  data.chats = Object.fromEntries(records.chat.map((c: { id: string; messages: Message[] }) => [c.id, c.messages]));
  // Keep legacy AI responses as history; old provider-specific cache keys are intentionally not reused.
  for (const c of records.cache) if (typeof c.text === 'string' && !data.chats[c.question_id + ':solution']) data.chats[c.question_id + ':solution'] = [{ role: 'assistant', text: c.text }];
  validateData(data); return data;
}
export async function saveAI(cid: string, messages: Message[], cacheKey?: string, generation = activeEpoch()) {
  const id = activeOwner(); assertActive(id, generation);
  await transact(data => { data.chats[cid] = [...(data.chats[cid] ?? []), ...messages.slice(-2)]; const last = messages.at(-1); if (cacheKey && last) data.cache[cacheKey] = { text: last.text, options: last.options }; });
}
